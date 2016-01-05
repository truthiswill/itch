
let StreamSearch = require('streamsearch')
let os = require('../../util/os')

let fstream = require('fstream')
let _ = require('underscore')

let log = require('../../util/log')('installers/generic')

let self = {
  install: async function (opts) {
    let installer = await self.find_installer(opts)
    await installer.install(opts)
  },

  uninstall: async function (opts) {
    let installer = await self.find_installer(opts)
    await installer.uninstall(opts)
  },

  find_installer: async function (opts) {
    if (os.platform() !== 'win32') {
      throw new Error('Exe installers are only supported on Windows')
    }

    let type = await self.identify(opts)

    log(opts, `found generic installer type: ${type}`)

    if (!type) {
      return require(`./naked`)
    }

    return require(`./${type}`)
  },

  identify: async function (opts) {
    let kind = await self.builtin_sniff(opts, self.builtin_needles)
    if (!kind) {
      kind = await self.external_sniff(opts, self.external_needles)
    }

    return kind
  },

  builtin_sniff: async function (opts, needles) {
    let archive_path = opts.archive_path
    let result = null
    let searches = []

    let on_info = (k, v, isMatch, data, start, end) => {
      if (!isMatch) return
      log(opts, `builtin_sniff: found needle ${v}`)
      result = k
    }

    for (let k of Object.keys(needles)) {
      let v = needles[k]
      let search = new StreamSearch(v)
      search.on('info', _.partial(on_info, k, v))
      searches.push(search)
    }

    let reader = fstream.Reader(archive_path)
    reader.on('data', buf => {
      for (let search of searches) {
        search.push(buf)
      }
    })

    let p = new Promise((resolve, reject) => {
      reader.on('end', () => resolve(result))
      reader.on('error', reject)
    })
    await p
  },

  builtin_needles: {
    // Boyer-Moore - longer strings means search is more efficient. That said,
    // we don't really use it to skip forward, it just allows us not to scan
    // entire buffers nodes gives us while reading the whole file
    'inno': 'Inno Setup Setup Data',
    'nsis': 'Nullsoft.NSIS.exehead',
    'air': 'META-INF/AIR/application.xml'
  },

  external_sniff: async function (opts, needles) {
    let archive_path = opts.archive_path

    // sample file_output:
    // ['PE32 executable (GUI) Intel 80386', 'for MS Windows', 'InstallShield self-extracting archive']
    let file = require('../../util/file')
    let file_output = await file(archive_path)
    let detail = file_output[2]

    if (!detail) return null

    for (let k of Object.keys(needles)) {
      let v = needles[k]
      if (detail === v) {
        log(opts, `external_sniff: found needle ${v}`)
        return k
      }
    }

    return null
  },

  external_needles: {
    // Just plain old regex being run on file(1)'s output
    'archive': 'InstallShield self-extracting archive'
  }
}

module.exports = self
