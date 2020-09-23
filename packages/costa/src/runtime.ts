import path from 'path';
import { createUnzip } from 'zlib';
import {
  createReadStream,
  createWriteStream,
  ensureDir,
  ensureDirSync,
  pathExists,
  remove,
  writeFile,
  readFile,
  access,
  mkdirp,
  readJson,
  writeJson
} from 'fs-extra';
import { download, constants, generateId, parsePluginName, PluginProtocol } from '@pipcook/pipcook-core';
import tar from 'tar-stream';
import { spawn, SpawnOptions } from 'child_process';
import { PluginRunnable, BootstrapArg } from './runnable';
import LRUCache from './lrucache';
import {
  NpmPackageMetadata,
  NpmPackage,
  NpmPackageNameSchema,
  RuntimeOptions,
  PluginPackage,
  PluginSource,
  CondaConfig
} from './index';
import { pipeLog, LogStdio, pipeGracefully, getPluginDirectory } from './utils';

import { get, RequestPromiseOptions } from 'request-promise';
import Debug from 'debug';

const debug = Debug('costa.runtime');

function selectNpmPackage(metadata: NpmPackageMetadata, source: PluginSource): NpmPackage {
  const { version } = source?.schema;
  if (version === 'beta') {
    if (metadata['dist-tags'].beta == null) {
      throw TypeError(`the package "${source.name}" has no beta version.`);
    }
    return metadata.versions[metadata['dist-tags'].beta];
  }
  if (version === 'latest') {
    return metadata.versions[metadata['dist-tags'].latest];
  }
  if (version) {
    // TODO(Yorkie): support version range just like (1.0.x, ^1.0.0, ...)
    return metadata.versions[source?.schema.version];
  }
  return metadata.versions[metadata['dist-tags'].latest];
}

interface InstallOptions {
  // the index mirror to install python packages.
  pyIndex?: string;
  // install from new anyway.
  force?: boolean;
  // install process stdout
  stdout: NodeJS.WritableStream;
  // install process stderr
  stderr: NodeJS.WritableStream;
}

function spawnAsync(command: string, args: string[], opts: SpawnOptions, stdio: LogStdio): Promise<void> {
  return new Promise((resolve, reject) => {
    opts.stdio = [ null, 'pipe', 'pipe' ];
    opts.detached = false;
    const child = spawn(command, args, opts);
    pipeLog(child.stdout, stdio.stdout, stdio.prefix);
    pipeLog(child.stderr, stdio.stderr, stdio.prefix);
    child.on('close', (code: number) => {
      code === 0 ? resolve() : reject(new TypeError(`invalid code ${code} from ${command}`));
    });
  });
}

async function extractPackageJsonFromReadable(readable: NodeJS.ReadableStream, pkgFilename: string): Promise<any> {
  let packageJson = '';
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    if (header.name === pkgFilename) {
      stream.on('data', (buf) => packageJson += buf);
    }
    stream.once('end', next);
    stream.resume();
  });
  await pipeGracefully(readable, extract);
  return JSON.parse(packageJson);
}

function fetchPackageJsonFromGit(remote: string, head: string): Promise<any> {
  const child = spawn('git', [
    'archive',
    `--remote=${remote}`,
    head,
    'package.json'
  ]);
  return extractPackageJsonFromReadable(child.stdout, 'package.json');
}

function fetchPackageJsonFromTarball(filename: string): Promise<any> {
  const stream = createReadStream(filename);
  return fetchPackageJsonFromTarballStream(stream);
}

async function fetchPackageJsonFromTarballStream(fileStream: NodeJS.ReadableStream): Promise<any> {
  const unzip = createUnzip();
  await pipeGracefully(fileStream, unzip);
  /**
   * the content of the tarball generated by `npm pack` is a directory named 'package'
   * look at: https://github.com/npm/cli/blob/3e7ed30d6e9211e39bd93ec4e254cc5a2b159947/lib/pack.js#L146
  */
  return extractPackageJsonFromReadable(unzip, 'package/package.json');
}

function createRequirements(name: string, config: CondaConfig): string[] {
  const deps = [];
  for (let k in config.dependencies) {
    const v = config.dependencies[k];
    if (v === '*') {
      deps.push(k);
    } else if (v.startsWith('git+https://') === true) {
      deps.push(v);
    } else {
      deps.push(`${k}==${v}`);
    }
  }
  return deps;
}

// TODO(Yorkie): support config this?
const HTTP_CACHE_LIMIT = 1000;

// TODO(Yorkie): support save caches in disk?
/**
 * The HTTP Cache in memory.
 */
interface HTTPCache {
  etag: string;
  lastModified: string;
  body: any;
}

/**
 * `HTTPCache` with the uri key.
 */
const httpCacheByURI = new LRUCache<HTTPCache>(HTTP_CACHE_LIMIT);

/**
 * This function uses etag to cache the response body with `HTTPCache`, the cache key is
 * the request uri. (This requires the requested server to support the etag cache control)
 *
 * @param uri The requested uri.
 */
async function requestHttpGetWithCache(uri: string): Promise<any> {
  const cache = httpCacheByURI.get(uri);
  const options: RequestPromiseOptions = {
    timeout: 15000,
    simple: false,
    resolveWithFullResponse: true
  };
  if (cache?.body) {
    options.headers = {
      'Cache-Control': 'max-age=0',
      'If-Modified-Since': cache?.lastModified,
      'If-None-Match': cache?.etag ? `W/${cache.etag}` : undefined
    };
  }
  const resp = await get(uri, options);
  if (resp.statusCode === 200) {
    const body = JSON.parse(resp.body);
    httpCacheByURI.put(uri, {
      etag: resp.headers.etag,
      lastModified: resp.headers['last-modified'],
      body
    });
    return body;
  } else if (resp.statusCode === 304) {
    debug(`using cached response for ${uri}.`);
    return cache.body;
  } else {
    throw new TypeError(resp.message);
  }
}

export { PluginPackage } from './index';
export { RunnableResponse } from './runnable';
export {
  PluginRunnable,
  BootstrapArg,
  InstallOptions
};

/**
 * The Costa runtime is for scheduling plugins and management.
 */
export class CostaRuntime {
  options: RuntimeOptions;

  /**
   * Create a new Costa runtime by given `RuntimeOptions`.
   * @param opts the runtime options.
   */
  constructor(opts: RuntimeOptions) {
    this.options = opts;
    process.env.NODE_PATH += `:${opts.installDir}/node_modules`;
    ensureDirSync(opts.installDir);
    ensureDirSync(opts.datasetDir);
    ensureDirSync(opts.componentDir);
  }

  /**
   * valid package info and assgin with source
   * @param pkg plugin package package info.
   * @param source source info.
   */
  validAndAssign(pkg: PluginPackage, source: PluginSource): PluginPackage {
    try {
      this.validPackage(pkg);
      this.assignPackage(pkg, source);
    } catch (err) {
      if (process.env.NODE_ENV === 'test') {
        console.warn('skip the valid package and assign because NODE_ENV is set to "test".');
      } else {
        throw err;
      }
    }
    return pkg;
  }

  /**
   * fetch plugin package info by plugin name
   * @param name plugin name
   * @param version plugin version
   * @param from where the plugin installed from
   */
  async fetchFromInstalledPlugin(name: string, version: string, from: PluginProtocol): Promise<PluginPackage> {
    return this.assignPackage(
      await readJson(path.join(constants.PIPCOOK_PLUGINS, 'node_modules', getPluginDirectory(name, version, from), 'package.json')),
      { from, name }
    );
  }

  /**
   * fetch and check if the package name is valid.
   * @param name the plugin package name.
   * @param cwd the current working directory.
   */
  async fetch(name: string): Promise<PluginPackage> {
    let pkg: PluginPackage;
    const source = this.getSource(name);
    if (source.from === 'npm') {
      debug(`requesting the url ${source.uri}`);
      // TODO(yorkie): support http cache
      const resp = await requestHttpGetWithCache(source.uri);
      const meta = resp as NpmPackageMetadata;
      pkg = selectNpmPackage(meta, source);
    } else if (source.from === 'git') {
      debug(`requesting the url ${source.uri}...`);
      const { hostname, auth, hash } = source.urlObject;
      let pathname = source.urlObject.pathname.replace(/^\/:?/, '');
      const remote = `${auth || 'git'}@${hostname}:${pathname}${hash || ''}`;
      pkg = await fetchPackageJsonFromGit(remote, 'HEAD');
    } else if (source.from === 'fs') {
      debug(`linking the url ${source.uri}`);
      pkg = await readJson(`${source.uri}/package.json`);
    } else if (source.from === 'tarball') {
      debug(`downloading the url ${source.uri}`);
      await download(source.name, source.uri);
      pkg = await fetchPackageJsonFromTarball(source.uri);
    }
    return this.validAndAssign(pkg, source);
  }

  /**
   * fetch and check if the package name is valid.
   * @param name the plugin package readstream for npm package tarball.
   * @param cwd the current working directory.
   */
  async fetchByStream(stream: NodeJS.ReadableStream): Promise<PluginPackage> {
    const fileDir = path.join(constants.PIPCOOK_TMPDIR, generateId());
    const filename = path.join(fileDir, 'pkg.tgz');
    await mkdirp(fileDir);
    const writeStream = createWriteStream(filename);
    await pipeGracefully(stream, writeStream);
    const pkg = await fetchPackageJsonFromTarball(filename);
    const source: PluginSource = {
      from: 'tarball',
      name: `${pkg.name}@${pkg.version}`,
      uri: filename
    };
    return this.validAndAssign(pkg, source);
  }

  /**
   * install node packages for plugin
   * @param pkg plugin package info
   * @param optsinstall options
   */
  private async installNodeModules(pkg: PluginPackage, opts: InstallOptions): Promise<void> {
    let pluginAbsName;
    if (pkg.pipcook.source.from === 'npm') {
      // install with alias if the plugin is from npm for multiple versions
      pluginAbsName = `${getPluginDirectory(pkg.name, pkg.version, 'npm')}@npm:${pkg.name}@${pkg.version}`;
      debug(`install the plugin from npm registry: ${pluginAbsName}`);
    } else {
      pluginAbsName = pkg.pipcook.source.uri;
      debug(`install the plugin from ${pluginAbsName}`);
    }
    const stdio = { stdout: opts.stdout, stderr: opts.stderr, prefix: 'NODE' };
    const npmExecOpts = { cwd: this.options.installDir };
    const npmArgs = [ 'pnpm', 'install', pluginAbsName, '-E', '-P' ];
    if (this.options.npmRegistryPrefix) {
      npmArgs.push(`--registry=${this.options.npmRegistryPrefix}`);
    }
    if (!await pathExists(`${this.options.installDir}/package.json`)) {
      // if not init for plugin directory, just run `npm init` and install boa firstly.
      await spawnAsync('npm', [ 'init', '-y' ], npmExecOpts, stdio);
    }
    return spawnAsync('npx', npmArgs, npmExecOpts, stdio);
  }

  /**
   * install python packages for plugin
   * @param pkg plugin package info
   * @param boaSrcPath boa source path
   * @param optsinstall options
   */
  private async installPythonPackages(pkg: PluginPackage, boaSrcPath: string, opts: InstallOptions): Promise<void> {
    if (pkg.conda?.dependencies) {
      const pluginStdName = `${pkg.name}@${pkg.version}`;
      const stdio = { stdout: opts.stdout, stderr: opts.stderr, prefix: 'PYTHON' };
      debug(`prepare the Python environment for ${pluginStdName}`);
      const envDir = path.join(this.options.installDir, 'conda_envs', pluginStdName);
      await remove(envDir);
      await ensureDir(envDir);

      debug(`install the Python environment for ${pluginStdName}`);
      const requirements = createRequirements(pluginStdName, pkg.conda);
      // just sync the copy to requirements.txt
      await writeFile(
        `${envDir}/requirements.txt`,
        requirements.join('\n')
      );

      let python;
      try {
        const condaInstallDir = await readFile(`${boaSrcPath}/.CONDA_INSTALL_DIR`, 'utf8');
        python = `${condaInstallDir}/bin/python3`;
        await access(python);
      } catch (err) {
        debug(`occuring an error when fetching conda: ${err && err.stack}`);
        throw new Error('Invalid boa/conda installation, please try to install.');
      }

      debug('conda environment is setup correctly, start downloading.');
      await spawnAsync(python, [ '-m', 'venv', envDir ], {}, stdio);
      // TODO(yorkie): check for access(pip3)
      let args = [ 'install' ];
      if (opts.pyIndex) {
        args = args.concat([ '-i', opts.pyIndex ]);
      }
      args = args.concat([
        '--default-timeout=1000',
        `--cache-dir=${this.options.installDir}/.pip`
      ]);

      for (const pkg of requirements) {
        const installArgs = args.concat([ pkg ]);
        await spawnAsync(`${envDir}/bin/pip3`, installArgs, {}, stdio);
      }
    } else {
      debug(`just skip the Python environment installation.`);
    }
  }

  /**
   * Install the given plugin by name.
   * @param pkg the plugin package.
   * @param opts install options
   */
  async install(pkg: PluginPackage, opts: InstallOptions): Promise<boolean> {
    if (opts.force === true) {
      await this.uninstall(pkg);
    }
    // check if the pkg is installed
    if ((await this.isInstalled(pkg.name)) && !opts.force) {
      debug(`skip install "${pkg.name}" because it already exists`);
      return true;
    }

    let boaSrcPath = path.join(__dirname, '../node_modules/@pipcook/boa');
    if (!await pathExists(boaSrcPath)) {
      try {
        // FIXME: ../../ means boa/lib/index.js
        boaSrcPath = path.join(require.resolve('@pipcook/boa'), '../../');
      } catch (err) {
        throw new TypeError(`boa(${boaSrcPath}) not exists, please try init again.`);
      }
    }

    await Promise.all([
      this.installNodeModules(pkg, opts),
      this.installPythonPackages(pkg, boaSrcPath, opts)
    ]);

    return true;
  }
  /**
   * Uninstall the given plugin by name.
   * @param pkgMeta the plugin package name and version.
   */
  async uninstall(pkgMeta: Record<'name' | 'version', string> | Record<'name' | 'version', string>[]): Promise<boolean> {
    const pkg = await readJson(path.join(this.options.installDir, 'package.json'));

    const removePkg = async (name: string, version: string) => {
      if (!await this.isInstalled(name)) {
        debug(`skip uninstall "${name}" because it not exists.`);
        return false;
      }
      await Promise.all([
        remove(path.join(this.options.installDir, 'node_modules', name)),
        remove(path.join(this.options.installDir, 'conda_envs', `${name}@${version}`))
      ]);
      if (pkg.dependencies && pkg.dependencies[name]) {
        delete pkg.dependencies[name];
      }
      return true;
    };

    let success = false;
    if (Array.isArray(pkgMeta)) {
      // any one uninstalls successfully, return true
      for (const meta of pkgMeta) {
        if (await removePkg(meta.name, meta.version)) {
          success = true;
        }
      }
    } else {
      success = await removePkg(pkgMeta.name, pkgMeta.version);
    }
    // remove dependencies
    if (success) {
      await writeJson(path.join(this.options.installDir, 'package.json'), pkg, { spaces: 2 });
    }
    return success;
  }
  /**
   * create a runnable.
   */
  async createRunnable(args?: BootstrapArg): Promise<PluginRunnable> {
    if (args?.customEnv) {
      throw new TypeError('"customEnv" is not allowed here.');
    }
    const runnable = new PluginRunnable(this, args?.logger, args?.id);
    const pluginNodePath = path.join(this.options.installDir, 'node_modules');
    await runnable.bootstrap({
      customEnv: {
        NODE_PATH: `${(process.env.NODE_PATH || '')}:${pluginNodePath}`
      },
      ...args
    });
    return runnable;
  }
  /**
   * Check the plugin installed
   * @param name
   */
  private isInstalled(name: string): Promise<boolean> {
    return pathExists(`${this.options.installDir}/node_modules/${name}`);
  }
  /**
   * Create the `NpmPackageNameSchema` object by a package name.
   * @param fullname the fullname of a package, like "@pipcook/test@1.x"
   * @returns the created `NpmPackageNameSchema` object.
   */
  private getNameSchema(fullname: string): NpmPackageNameSchema {
    let schema = new NpmPackageNameSchema();
    if (fullname[0] === '@') {
      const scopeEnds = fullname.search('/');
      if (scopeEnds === -1) {
        throw new TypeError(`invalid package name: ${fullname}`);
      }
      schema.scope = fullname.substr(0, scopeEnds);
      fullname = fullname.substr(scopeEnds + 1);
    }
    const [ name, version ] = fullname.split('@');
    schema.name = name;
    schema.version = version ? version : null;
    return schema;
  }
  /**
   * Get the `PluginSource` object by a package name.
   * @param name the package name.
   * @param cwd the current working dir.
   */
  private getSource(name: string): PluginSource {
    const { protocol, urlObject } = parsePluginName(name);
    const src: PluginSource = {
      from: protocol,
      name,
      uri: null,
      urlObject
    };
    if (protocol === 'fs' || protocol === 'git') {
      src.uri = name;
    } else if (protocol === 'tarball') {
      src.uri = path.join(constants.PIPCOOK_TMPDIR, generateId(), path.basename(urlObject.pathname));
    } else if (protocol === 'npm') {
      src.schema = this.getNameSchema(name);
      let { npmRegistryPrefix } = this.options;
      if (npmRegistryPrefix.slice(-1) === '/') {
        npmRegistryPrefix = npmRegistryPrefix.slice(0, -1);
      }
      src.uri = `${npmRegistryPrefix}/${src.schema.packageName}`;
    }
    return src;
  }
  /**
   * Valid the package.
   * @param pkg the plugin package.
   */
  private validPackage(pkg: PluginPackage): void {
    if (!pkg.pipcook) {
      throw new TypeError('Invalid plugin package.json, not found on "pipcook"');
    }
  }

  /**
   * Assign some fields to package.
   * @param pkg plugin info
   * @param source plugin source for installation
   */
  private assignPackage(pkg: PluginPackage, source: PluginSource): PluginPackage {
    const { installDir } = this.options;
    pkg.pipcook.source = source;
    pkg.pipcook.target = {
      PYTHONPATH: path.join(
        installDir, `conda_envs/${pkg.name}@${pkg.version}`, 'lib/python3.7/site-packages'),
      DESTPATH: path.join(
        // TODO(feely): not implement the version
        installDir, `node_modules/${pkg.name}@${pkg.version}`)
    };
    return pkg;
  }
}
