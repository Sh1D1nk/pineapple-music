/** Minimal iterative radix-2 FFT. Sizes must be powers of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n <= 1) return
  if ((n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two')

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]!
        const aIm = im[i + k]!
        const bRe = re[i + k + len / 2]!
        const bIm = im[i + k + len / 2]!
        const tRe = bRe * curRe - bIm * curIm
        const tIm = bRe * curIm + bIm * curRe
        re[i + k] = aRe + tRe
        im[i + k] = aIm + tIm
        re[i + k + len / 2] = aRe - tRe
        im[i + k + len / 2] = aIm - tIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  return w
}

/** Magnitude spectrum of a real frame, bin 0..size/2 inclusive. */
export function magnitudeSpectrum(frame: Float64Array, window: Float64Array): Float64Array {
  const n = frame.length
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = frame[i]! * window[i]!
  fft(re, im)
  const half = n / 2 + 1
  const mag = new Float64Array(half)
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i]!, im[i]!)
  return mag
}
