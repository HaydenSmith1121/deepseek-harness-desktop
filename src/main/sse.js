'use strict';

/**
 * 增量 SSE（Server-Sent Events）解析器。
 * 逐块喂入文本，按行切分，解析 "data: ..." 事件。
 * [DONE] 哨兵会被归一化为 null 事件。
 */
class SseParser {
  /**
   * @param {(obj: object|null) => void} onEvent 每解析出一个完整事件回调一次
   */
  constructor(onEvent) {
    this.buf = '';
    this.onEvent = onEvent;
  }

  feed(text) {
    this.buf += text;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop(); // 最后一段可能是半行，留到下一轮
    for (const line of parts) this._handleLine(line);
  }

  /** 流结束时调用，冲刷残余缓冲 */
  end() {
    if (this.buf) {
      this._handleLine(this.buf);
      this.buf = '';
    }
  }

  _handleLine(line) {
    if (!line) return;
    if (!line.startsWith('data:')) return; // 忽略注释行/空行/event: 行
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      this.onEvent(null);
      return;
    }
    try {
      this.onEvent(JSON.parse(data));
    } catch (err) {
      // 单条坏数据不中断整个流
    }
  }
}

module.exports = { SseParser };
