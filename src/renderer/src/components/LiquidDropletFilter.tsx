/**
 * 水滴的「液态玻璃」滤镜。
 *
 * 思路（Chromium 专属但我们是 Electron，稳）：
 *   1. 程序生成一张位移图：R 通道存 x 位移、G 通道存 y 位移，中心 128/128 无位移，
 *      边缘按 r² 拉开 —— 这就是一枚凸透镜的折射场。
 *   2. 用 SVG feImage 把这张图喂给 feDisplacementMap，弯折元素背后的内容。
 *   3. 末尾接 feGaussianBlur，一次拿到「折射 + 模糊」，比叠两层 backdrop-filter 干净。
 *
 * 元素上只需要 `backdrop-filter: url(#lg-droplet)`。
 */
import type { JSX } from 'react'

const MAP_SIZE = 256
const FILTER_ID = 'lg-droplet'

let cachedMap: string | null = null

function displacementMap(): string {
  if (cachedMap) return cachedMap
  const canvas = document.createElement('canvas')
  canvas.width = MAP_SIZE
  canvas.height = MAP_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const image = ctx.createImageData(MAP_SIZE, MAP_SIZE)
  const data = image.data
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      // 归一化到 [-1, 1]
      const nx = (x / (MAP_SIZE - 1)) * 2 - 1
      const ny = (y / (MAP_SIZE - 1)) * 2 - 1
      const radius = Math.min(1, Math.hypot(nx, ny))
      // r² 让中心平坦、边缘陡峭：中心几乎不弯，靠边才明显（真实液滴的厚度分布）
      const bend = radius * radius
      const i = (y * MAP_SIZE + x) * 4
      data[i] = 128 + nx * bend * 127
      data[i + 1] = 128 + ny * bend * 127
      data[i + 2] = 0
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  cachedMap = canvas.toDataURL('image/png')
  return cachedMap
}

export function LiquidDropletFilter(): JSX.Element {
  const map = displacementMap()
  return (
    <svg className="lgFilterHost" aria-hidden="true">
      <defs>
        <filter
          id={FILTER_ID}
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
          colorInterpolationFilters="sRGB"
        >
          <feImage href={map} result="map" width="100%" height="100%" preserveAspectRatio="none" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="46"
            xChannelSelector="R"
            yChannelSelector="G"
            result="warp"
          />
          <feGaussianBlur in="warp" stdDeviation="1.6" />
        </filter>
      </defs>
    </svg>
  )
}

export const DROPLET_FILTER_ID = FILTER_ID
