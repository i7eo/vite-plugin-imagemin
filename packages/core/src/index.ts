import type { Plugin, ResolvedConfig } from 'vite'
import type { VitePluginImageMin } from './types'
import path from 'pathe'
import fs from 'fs-extra'
import {
  isNotFalse,
  isBoolean,
  isRegExp,
  isFunction,
  readAllFiles,
} from '../src/utils'
import chalk from 'chalk'
import Debug from 'debug'

import imagemin from 'imagemin'
import imageminGif from 'imagemin-gifsicle'
import imageminPng from 'imagemin-pngquant'
import imageminOptPng from 'imagemin-optipng'
import imageminJpeg from 'imagemin-mozjpeg'
import imageminSvgo from 'imagemin-svgo'
import imageminWebp from 'imagemin-webp'
import imageminJpegTran from 'imagemin-jpegtran'

import type { Options as GifsicleOptions } from 'imagemin-gifsicle'
import type { Options as SvgoOptions } from 'imagemin-svgo'
import type { Options as MozjpegOptions } from 'imagemin-mozjpeg'
import type { Options as OptipngOptions } from 'imagemin-optipng'
import type { Options as PngquantOptions } from 'imagemin-pngquant'
import type { Options as WebpOptions } from 'imagemin-webp'
import type { Options as JpegOptions } from 'imagemin-jpegtran'

type EnabledOptions<T> = T | false

export interface SvgOption extends SvgoOptions {
  plugins: any[]
}

export interface VitePluginImageMin {
  /**
   * Log compressed files and their compression ratios.
   * @default: true
   */
  verbose?: boolean
  /**
   * Filter files that do not need to be compressed
   */
  filter?: RegExp | ((file: string) => boolean)
  /**
   * Whether to enable compression
   * @default: false
   */
  disable?: boolean
  /**
   * gif compression configuration
   * @default: {enabled:true}
   */
  gifsicle?: EnabledOptions<GifsicleOptions>
  /**
   * svg compression configuration
   * @default: {enabled:true}
   */
  svgo?: EnabledOptions<SvgOption>
  /**
   * jpeg compression configuration
   * @default: {enabled:false}
   */
  mozjpeg?: EnabledOptions<MozjpegOptions>
  /**
   * png compression configuration
   * @default: {enabled:true}
   */
  optipng?: EnabledOptions<OptipngOptions>
  /**
   * png compression configuration
   * @default: {enabled:false}
   */
  pngquant?: EnabledOptions<PngquantOptions>
  /**
   * webp compression configuration
   * @default: {enabled:false}
   */
  webp?: EnabledOptions<WebpOptions>

  /**
   * jpeg compression configuration
   * @default: {enabled:true}
   */
  jpegTran?: EnabledOptions<JpegOptions>
}

import fs from 'fs-extra'
import path from 'path'

export const isFunction = (arg: unknown): arg is (...args: any[]) => any =>
  typeof arg === 'function'

export const isBoolean = (arg: unknown): arg is boolean => {
  return typeof arg === 'boolean'
}

export const isObject = (arg: unknown): arg is boolean => {
  return typeof arg === 'object'
}

export const isNotFalse = (arg: unknown): arg is boolean => {
  return !(isBoolean(arg) && !arg)
}

export const isRegExp = (arg: unknown): arg is RegExp =>
  Object.prototype.toString.call(arg) === '[object RegExp]'

/*
 * Read all files in the specified folder, filter through regular rules, and return file path array
 * @param root Specify the folder path
 * [@param] reg Regular expression for filtering files, optional parameters
 * Note: It can also be deformed to check whether the file path conforms to regular rules. The path can be a folder or a file. The path that does not exist is also fault-tolerant.
 */
export function readAllFiles(root: string, reg?: RegExp) {
  let resultArr: string[] = []
  try {
    if (fs.existsSync(root)) {
      const stat = fs.lstatSync(root)
      if (stat.isDirectory()) {
        // dir
        const files = fs.readdirSync(root)
        files.forEach(function (file) {
          const t = readAllFiles(path.join(root, '/', file), reg)
          resultArr = resultArr.concat(t)
        })
      } else {
        if (reg !== undefined) {
          if (isFunction(reg.test) && reg.test(root)) {
            resultArr.push(root)
          }
        } else {
          resultArr.push(root)
        }
      }
    }
  } catch (error) {
    console.log(error)
  }

  return resultArr
}


const debug = Debug.debug('vite-plugin-imagemin')

const extRE = /\.(png|jpeg|gif|jpg|bmp|svg)$/i

export default function (options: VitePluginImageMin = {}) {
  let outputPath: string
  let publicDir: string
  let config: ResolvedConfig

  const { disable = false, filter = extRE, verbose = true } = options

  if (disable) {
    return {} as any
  }

  debug('plugin options:', options)

  const mtimeCache = new Map<string, number>()
  let tinyMap = new Map<
    string,
    { size: number; oldSize: number; ratio: number }
  >()

  async function processFile(filePath: string, buffer: Buffer) {
    let content: Buffer

    try {
      content = await imagemin.buffer(buffer, {
        plugins: getImageminPlugins(options),
      })

      const size = content.byteLength,
        oldSize = buffer.byteLength

      tinyMap.set(filePath, {
        size: size / 1024,
        oldSize: oldSize / 1024,
        ratio: size / oldSize - 1,
      })

      return content
    } catch (error) {
      config.logger.error('imagemin error:' + filePath)
    }
  }

  return {
    name: 'vite:imagemin',
    apply: 'build',
    enforce: 'post',
    configResolved(resolvedConfig) {
      config = resolvedConfig
      outputPath = config.build.outDir

      // get public static assets directory: https://vitejs.dev/guide/assets.html#the-public-directory
      if (typeof config.publicDir === 'string') {
        publicDir = config.publicDir
      }

      debug('resolvedConfig:', resolvedConfig)
    },
    async generateBundle(_, bundler) {
      tinyMap = new Map()
      const files: string[] = []

      Object.keys(bundler).forEach((key) => {
        filterFile(path.resolve(outputPath, key), filter) && files.push(key)
      })

      debug('files:', files)

      if (!files.length) {
        return
      }

      const handles = files.map(async (filePath: string) => {
        const source = (bundler[filePath] as any).source
        const content = await processFile(filePath, source)
        if (content) {
          ;(bundler[filePath] as any).source = content
        }
      })

      await Promise.all(handles)
    },
    async closeBundle() {
      if (publicDir) {
        const files: string[] = []

        // try to find any static images in original static folder
        readAllFiles(publicDir).forEach((file) => {
          filterFile(file, filter) && files.push(file)
        })

        if (files.length) {
          const handles = files.map(async (publicFilePath: string) => {
            // now convert the path to the output folder
            const filePath = publicFilePath.replace(publicDir + path.sep, '')
            const fullFilePath = path.join(outputPath, filePath)

            if (fs.existsSync(fullFilePath) === false) {
              return
            }

            const { mtimeMs } = await fs.stat(fullFilePath)
            if (mtimeMs <= (mtimeCache.get(filePath) || 0)) {
              return
            }

            const buffer = await fs.readFile(fullFilePath)
            const content = await processFile(filePath, buffer)

            if (content) {
              await fs.writeFile(fullFilePath, content)
              mtimeCache.set(filePath, Date.now())
            }
          })

          await Promise.all(handles)
        }
      }

      if (verbose) {
        handleOutputLogger(config, tinyMap)
      }
    },
  } as Plugin
}

// Packed output logic
function handleOutputLogger(
  config: ResolvedConfig,
  recordMap: Map<string, { size: number; oldSize: number; ratio: number }>,
) {
  config.logger.info(
    `\n${chalk.cyan('✨ [vite-plugin-imagemin]')}` +
      '- compressed image resource successfully: ',
  )

  const keyLengths = Array.from(recordMap.keys(), (name) => name.length)
  const valueLengths = Array.from(
    recordMap.values(),
    (value) => `${Math.floor(100 * value.ratio)}`.length,
  )

  const maxKeyLength = Math.max(...keyLengths)
  const valueKeyLength = Math.max(...valueLengths)
  recordMap.forEach((value, name) => {
    let { ratio } = value
    const { size, oldSize } = value
    ratio = Math.floor(100 * ratio)
    const fr = `${ratio}`

    const denseRatio =
      ratio > 0 ? chalk.red(`+${fr}%`) : ratio <= 0 ? chalk.green(`${fr}%`) : ''

    const sizeStr = `${oldSize.toFixed(2)}kb / tiny: ${size.toFixed(2)}kb`

    config.logger.info(
      chalk.dim(path.basename(config.build.outDir)) +
        '/' +
        chalk.blueBright(name) +
        ' '.repeat(2 + maxKeyLength - name.length) +
        chalk.gray(`${denseRatio} ${' '.repeat(valueKeyLength - fr.length)}`) +
        ' ' +
        chalk.dim(sizeStr),
    )
  })
  config.logger.info('\n')
}

function filterFile(
  file: string,
  filter: RegExp | ((file: string) => boolean),
) {
  if (filter) {
    const isRe = isRegExp(filter)
    const isFn = isFunction(filter)
    if (isRe) {
      return (filter as RegExp).test(file)
    }
    if (isFn) {
      return (filter as (file: any) => any)(file)
    }
  }
  return false
}

// imagemin compression plugin configuration
function getImageminPlugins(
  options: VitePluginImageMin = {},
): imagemin.Plugin[] {
  const {
    gifsicle = true,
    webp = false,
    mozjpeg = false,
    pngquant = false,
    optipng = true,
    svgo = true,
    jpegTran = true,
  } = options

  const plugins: imagemin.Plugin[] = []

  if (isNotFalse(gifsicle)) {
    debug('gifsicle:', true)
    const opt = isBoolean(gifsicle) ? undefined : gifsicle
    plugins.push(imageminGif(opt))
  }

  if (isNotFalse(mozjpeg)) {
    debug('mozjpeg:', true)
    const opt = isBoolean(mozjpeg) ? undefined : mozjpeg
    plugins.push(imageminJpeg(opt))
  }

  if (isNotFalse(pngquant)) {
    debug('pngquant:', true)
    const opt = isBoolean(pngquant) ? undefined : pngquant
    plugins.push(imageminPng(opt))
  }

  if (isNotFalse(optipng)) {
    debug('optipng:', true)
    const opt = isBoolean(optipng) ? undefined : optipng
    plugins.push(imageminOptPng(opt))
  }

  if (isNotFalse(svgo)) {
    debug('svgo:', true)
    const opt = isBoolean(svgo) ? undefined : svgo

    // if (opt !== null && isObject(opt) && Reflect.has(opt, 'plugins')) {
    //   (opt as any).plugins.push({
    //     name: 'preset-default',
    //   });
    // }
    plugins.push(imageminSvgo(opt))
  }

  if (isNotFalse(webp)) {
    debug('webp:', true)
    const opt = isBoolean(webp) ? undefined : webp
    plugins.push(imageminWebp(opt))
  }

  if (isNotFalse(jpegTran)) {
    debug('webp:', true)
    const opt = isBoolean(jpegTran) ? undefined : jpegTran
    plugins.push(imageminJpegTran(opt))
  }
  return plugins
}
