/// <reference types="vite/client" />

declare module '*?url' {
  const src: string
  export default src
}

interface Window {
  lm: {
    invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
    on: (channel: string, listener: (payload: never) => void) => () => void
  }
}

declare module 'signalsmith-stretch' {
  const SignalsmithStretch: (
    context: BaseAudioContext,
    channelOptions?: Record<string, unknown>
  ) => Promise<
    AudioNode & {
      addBuffers: (buffers: Float32Array[]) => Promise<{ start: number; end: number }>
      schedule: (change: {
        output?: number
        active?: boolean
        input?: number
        rate?: number
        semitones?: number
      }) => void
      start: (when?: number) => void
      stop: (when?: number) => void
      setUpdateInterval: (seconds: number, callback?: (time: number) => void) => void
      configure: (options: Record<string, unknown>) => void
      latency: () => number
    }
  >
  export default SignalsmithStretch
}
