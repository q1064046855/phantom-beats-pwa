/* PHANTOM BEATS v3.46 麦克风录音 Worklet（音频线程内运行，手机全平台） */
class MicRecorderProcessor extends AudioWorkletProcessor {
  process(inputs){
    const input = inputs[0];
    if (input && input.length){
      const ch = input[0];
      if (ch && ch.length){
        const i16 = new Int16Array(ch.length);
        for (let i = 0; i < ch.length; i++){
          let s = ch[i];
          if (s > 1) s = 1; else if (s < -1) s = -1;
          i16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        this.port.postMessage(i16.buffer, [i16.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('mic-recorder', MicRecorderProcessor);
