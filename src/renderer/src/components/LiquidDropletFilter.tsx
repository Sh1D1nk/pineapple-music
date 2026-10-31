import type { JSX } from 'react'

/**
 * 底栏气泡的「液态玻璃」滤镜。
 *
 * 参数照 HeyBox-LiquidGlass 的两套配置（applyQmParams 与 tabBar 的设置）：
 *   底栏：dispersion 0.12
 *   气泡：DISPERSION 0.35、BLUR_RADIUS 1.2、REFRACTION_HEIGHT 20dp
 * 也就是说气泡的色散要接近底栏的 3 倍 —— 这里用「位移折射 + RGB 三通道错位 + 模糊」实现：
 *
 *   1. 位移图：R 通道存 x 位移、G 通道存 y 位移，中心 128/128 无位移，边缘按 r² 拉开（凸透镜）
 *   2. feDisplacementMap 弯折背景
 *   3. R/B 通道各偏移 ±1.6px、G 居中，再 screen 合成 —— 这就是色散（chromatic aberration）
 *   4. feGaussianBlur 收尾，一次拿到「折射 + 色散 + 模糊」
 */
const MAP_SIZE = 256
const FILTER_ID = 'lg-droplet'
/** 色散像素偏移：原版气泡的色散约为底栏 3 倍，这里落在 1.6px 上肉眼刚好明显 */
const DISPERSION_PX = 1.6
/** 气泡模糊（原版 BLUR_RADIUS 1.2，CSS 侧折算约 3px） */
const BLUR_PX = 3

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
      const nx = (x / (MAP_SIZE - 1)) * 2 - 1
      const ny = (y / (MAP_SIZE - 1)) * 2 - 1
      const radius = Math.min(1, Math.hypot(nx, ny))
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
          x="-40%"
          y="-40%"
          width="180%"
          height="180%"
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
          {/* 色散：R 往右、B 往左，G 留在中间，再 screen 叠回去 */}
          <feOffset in="warp" dx={DISPERSION_PX} dy="0" result="redShift" />
          <feOffset in="warp" dx={-DISPERSION_PX} dy="0" result="blueShift" />
          <feColorMatrix
            in="redShift"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="redOnly"
          />
          <feColorMatrix
            in="warp"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="greenOnly"
          />
          <feColorMatrix
            in="blueShift"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            result="blueOnly"
          />
          <feBlend in="redOnly" in2="greenOnly" mode="screen" result="redGreen" />
          <feBlend in="redGreen" in2="blueOnly" mode="screen" result="dispersed" />
          <feGaussianBlur in="dispersed" stdDeviation={BLUR_PX} />
        </filter>
      </defs>
    </svg>
  )
}

export const DROPLET_FILTER_ID = FILTER_ID
