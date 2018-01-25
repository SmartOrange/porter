'use strict'

/**
 * @module
 */

const path = require('path')
const crypto = require('crypto')
const mime = require('mime')
const debug = require('debug')('porter')

const postcss = require('postcss')
const autoprefixer = require('autoprefixer')
const fs = require('mz/fs')

const atImport = require('./lib/atImport')
const parseId = require('./lib/parseId')
const parseMap = require('./lib/parseMap')
const parseSystem = require('./lib/parseSystem')
const define = require('./lib/define')
const compileAll = require('./lib/compileAll')
const compileStyleSheets = require('./lib/compileStyleSheets')
const findComponent = require('./lib/findComponent')
const findModule = require('./lib/findModule')
const Cache = require('./lib/Cache')
const matchRequire = require('./lib/matchRequire')
const transform = require('./lib/transform')
const findBabelrc = require('./lib/findBabelrc')

const loaderPath = path.join(__dirname, 'loader.js')
const loaderSource = fs.readFileSync(loaderPath, 'utf8').replace(/\$\{(\w+)\}/g, function(m, key) {
  if (key == 'NODE_ENV') {
    return process.env.NODE_ENV || 'development'
  } else {
    return ''
  }
})
const loaderStats = fs.statSync(loaderPath)

const serviceWorkerPath = path.join(__dirname, 'porter-sw.js')
const serviceWorkerSource = fs.readFileSync(serviceWorkerPath, 'utf8')
const serviceWorkerStats = fs.statSync(serviceWorkerPath)

const RE_EXT = /(\.\w+)$/i
const RE_ASSET_EXT = /\.(?:gif|jpg|jpeg|png|svg|swf|ico)$/i

const { exists, lstat, readFile } = fs


/**
 * @typedef  {Module}
 * @type     {Object}
 * @property {string} name
 * @property {string} version
 * @property {string} entry
 *
 * @typedef  {DependenciesMap}
 * @type     {Object}
 *
 * @typedef  {System}
 * @type     {Object}
 * @property {Object} dependencies
 * @property {Object} modules
 *
 * @typedef  {uAST}
 * @type     {Object}
 */


/**
 * Factory
 *
 * @param {Object}           opts
 * @param {string|string[]} [opts.cacheExcept=[]]         Cache exceptions
 * @param {boolean}         [opts.cachePersist=false]     Don't clear cache every time
 * @param {string}          [opts.dest=public]            Cache destination
 * @param {string}          [opts.type='AsyncFunction']   Type of the middleware function
 * @param {Object}          [opts.loaderConfig={}]        Loader config
 * @param {boolean}         [opts.mangleExcept=[]]        Mangle exceptions
 * @param {string|string[]} [opts.paths=components]       Base directory name or path
 * @param {string}          [opts.root=process.cwd()]     Override current working directory
 * @param {boolean}         [opts.serveSource=false]      Serve sources for devtools
 *
 * @returns {Function|GeneratorFunction} A middleware for Koa or Express
 */
function porter(opts = {}) {
  const encoding = 'utf8'
  const root = opts.root || process.cwd()
  const dest = path.resolve(root, opts.dest || 'public')
  const cacheExceptions = opts.cacheExcept ? [].concat(opts.cacheExcept) : []
  const mangleExceptions = opts.mangleExcept ? [].concat(opts.mangleExcept) : []
  const transformModuleNames = opts.transformOnly ? [].concat(opts.transformOnly) : []
  const serveSource = opts.serveSource
  const loaderConfig = opts.loaderConfig || {}
  const paths = [].concat(opts.paths || 'components').map(function(dir) {
    return path.resolve(root, dir)
  })

  const cache = new Cache({
    dest,
    encoding,
    root
  })

  if (cacheExceptions.length) debug('Cache exceptions %s', cacheExceptions)
  if (serveSource) debug('Serving source files.')

  let dependenciesMap = null
  let system = null
  let pkg = require(path.join(root, 'package.json'))
  let parseSystemPromise = null
  let parseSystemError = null

  if (['name', 'version', 'main', 'modules'].every(name => !!loaderConfig[name])) {
    parseSystemPromise = Promise.resolve()
    pkg = system = loaderConfig
  } else {
    parseSystemPromise = parseMap(opts).then(map => {
      dependenciesMap = map
      system = parseSystem(dependenciesMap)
      Object.assign(loaderConfig, system)
    }).catch(err => parseSystemError = err)
  }
  // To be able to skip caching of certain dependencies in registry-cache.js too.
  loaderConfig.cacheExcept = cacheExceptions

  cache.removeAll(opts.cachePersist ? [pkg.name, ...cacheExceptions] : null)
    .then(function() {
      debug('Cache %s cleared', dest)
    }, function(err) {
      console.error(err.stack)
    })

  function mightCacheModule(mod) {
    if (mod.name === pkg.name ||
        cacheExceptions[0] === '*' ||
        cacheExceptions.indexOf(mod.name) >= 0 ||
        !dependenciesMap) {
      return
    }

    cache.precompile(mod, {
      dependenciesMap,
      system,
      mangle: !mangleExceptions.includes(mod.name)
    })
  }

  async function formatMain(id, content) {
    return `${loaderSource}
porter.config(${JSON.stringify(loaderConfig)})
${content}
porter["import"](${JSON.stringify(id.replace(RE_EXT, ''))})
`
  }

  async function readScript(id, isMain) {
    const mod = parseId(id, system)

    if (mod.name == pkg.name || !(mod.name in system.modules)) {
      return await readComponent(id, isMain)
    } else {
      return await readModule(id)
    }
  }

  async function readComponent(id, isMain) {
    const mod = parseId(id, system)

    if (!(mod.name in system.modules)) {
      mod.name = system.name
      mod.version = system.version
      mod.entry = id
    }

    const [fpath] = await findComponent(mod.entry, paths)
    if (!fpath) return
    const stats = await lstat(fpath)
    const source = await readFile(fpath, encoding)
    const babelrcPath = await findBabelrc(fpath, { root })
    let content = babelrcPath ? (await cache.read(id, source)) : source

    if (!content) {
      const result = transform(source, {
        filename: id,
        filenameRelative: path.relative(root, fpath),
        sourceFileName: path.relative(root, fpath),
        extends: babelrcPath
      })
      await Promise.all([
        cache.write(id, source, result.code),
        cache.writeFile(`${id}.map`, JSON.stringify(result.map, function(k, v) {
          if (k != 'sourcesContent') return v
        }))
      ])
      content = result.code
    }

    const dependencies = matchRequire.findAll(content)
    content = define(id.replace(RE_EXT, ''), dependencies, content)
    content = isMain
      ? await formatMain(id, content)
      : `${content}
//# sourceMappingURL=./${path.basename(id)}.map`

    return [content, {
      'Last-Modified': stats.mtime.toJSON()
    }]
  }

  async function readModule(id, isMain) {
    const mod = parseId(id, system)
    const { dir } = findModule(mod, dependenciesMap)
    const fpath = path.join(dir, mod.entry)

    if (!fpath) return
    if (mod.name in system.modules) mightCacheModule(mod)

    const babelrcPath = await findBabelrc(fpath, { root: dir })
    let source = await readFile(fpath, encoding)
    let content = transformModuleNames.includes(mod.name) && babelrcPath
      ? (await cache.read(id, source))
      : source

    if (!content) {
      const result = transform(source, {
        filename: id,
        filenameRelative: path.relative(root, fpath),
        sourceFileName: path.relative(root, fpath),
        extends: babelrcPath,
      })
      await Promise.all([
        cache.write(id, source, result.code),
        cache.writeFile(`${id}.map`, JSON.stringify(result.map, function(k, v) {
          if (k != 'sourcesContent') return v
        }))
      ])
      content = result.code
    }
    const stats = await lstat(fpath)
    const dependencies = matchRequire.findAll(content)
    content = define(id.replace(RE_EXT, ''), dependencies, content)

    return [content, {
      'Last-Modified': stats.mtime.toJSON()
    }]
  }

  let importer
  const prefixer = postcss().use(autoprefixer())

  async function readStyle(id) {
    if (!importer) importer = postcss().use(atImport({ paths, dependenciesMap, system }))
    const mod = parseId(id, system)
    if (!(mod.name in system.modules)) {
      mod.name = system.name
      mod.version = system.version
      mod.entry = id
    }
    const destPath = path.join(dest, id)
    const [fpath] = await findComponent(mod.entry, paths)

    if (!fpath) return

    const source = await readFile(fpath, encoding)
    const processOpts = {
      from: path.relative(root, fpath),
      to: path.relative(root, destPath),
      map: { inline: false }
    }
    const result = await importer.process(source, processOpts)
    let content = await cache.read(id, result.css)

    if (!content) {
      processOpts.map.prev = result.map
      const resultWithPrefix = await prefixer.process(result.css, processOpts)

      await Promise.all([
        cache.write(id, result.css, resultWithPrefix.css),
        cache.writeFile(id + '.map', resultWithPrefix.map)
      ])
      content = resultWithPrefix.css
    }

    return [content, {
      'Last-Modified': (await lstat(fpath)).mtime.toJSON()
    }]
  }

  function isSource(id) {
    const fpath = path.join(root, id)
    return id.indexOf('node_modules') === 0 || paths.some(function(base) {
      return fpath.indexOf(base) === 0
    })
  }

  async function readSource(id) {
    const fpath = path.join(root, id)

    if (await exists(fpath)) {
      const [ content, stats ] = await Promise.all([
        readFile(fpath, encoding), lstat(fpath)
      ])

      return [content, {
        'Last-Modified': stats.mtime.toJSON()
      }]
    }
  }

  async function readAsset(id, isMain) {
    // Both js and css requires dependenciesMap and system to be ready
    await parseSystemPromise

    const ext = path.extname(id)
    let result = null

    if (id === 'loader.js') {
      result = [`
${loaderSource}
porter.config(${JSON.stringify(loaderConfig)})
`, {
        'Last-Modified': loaderStats.mtime.toJSON()
      }]
    }
    else if (id === 'loaderConfig.json') {
      result = [JSON.stringify(system), {
        'Last-Modified': loaderStats.mtime.toJSON()
      }]
    }
    else if (id === 'porter-sw.js') {
      result = [serviceWorkerSource, {
        'Last-Modified': serviceWorkerStats.mtime.toJSON()
      }]
    }
    else if (serveSource && isSource(id)) {
      result = await readSource(id)
    }
    else if (ext === '.js') {
      result = await readScript(id, isMain)
    }
    else if (ext === '.css') {
      result = await readStyle(id, isMain)
    }
    else if (RE_ASSET_EXT.test(ext)) {
      const [fpath] = await findComponent(id, paths)
      if (fpath) {
        const content = await readFile(fpath)
        const stats = await lstat(fpath)

        result = [content, {
          'Last-Modified': stats.mtime.toJSON()
        }]
      }
    }

    if (result) {
      Object.assign(result[1], {
        'Cache-Control': 'max-age=0',
        'Content-Type': mime.lookup(ext),
        ETag: crypto.createHash('md5').update(result[0]).digest('hex')
      })
    }

    return result
  }

  function expressFn(req, res, next) {
    if (parseSystemError) next(parseSystemError)
    if (res.headerSent) return next()

    const id = req.path.slice(1)
    const isMain = 'main' in req.query

    readAsset(id, isMain).then(function(result) {
      if (result) {
        res.statusCode = 200
        res.set(result[1])
        if (req.fresh) {
          res.statusCode = 304
        } else {
          res.write(result[0])
        }
        res.end()
      }
      else {
        next()
      }
    }).catch(next)
  }

  function* generatorFn(next) {
    const ctx = this
    if (parseSystemError) throw parseSystemError
    if (ctx.headerSent) return yield next

    const id = ctx.path.slice(1)
    const isMain = 'main' in ctx.query
    const result = yield readAsset(id, isMain)

    if (result) {
      ctx.status = 200
      ctx.set(result[1])
      if (ctx.fresh) {
        ctx.status = 304
      } else {
        ctx.body = result[0]
      }
    }
    else {
      yield next
    }
  }

  async function asyncFn(ctx, next) {
    if (parseSystemError) throw parseSystemError
    if (ctx.headerSent) return await next

    const id = ctx.path.slice(1)
    const isMain = 'main' in ctx.query
    const result = await readAsset(id, isMain)

    if (result) {
      ctx.status = 200
      ctx.set(result[1])
      if (ctx.fresh) {
        ctx.status = 304
      } else {
        ctx.body = result[0]
      }
    }
    else {
      await next
    }
  }

  switch (opts.type) {
  case 'Function':
    return expressFn
  case 'GeneratorFunction':
    return generatorFn
  default:
    return asyncFn
  }
}


module.exports = Object.assign(porter, {
  parseMap,
  parseSystem,
  compileAll: compileAll.compileAll,
  compileComponent: compileAll.compileComponent,
  compileModule: compileAll.compileModule,
  compileStyleSheets
})