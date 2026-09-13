'use strict';

const test = require('node:test');
const assert = require('node:assert');
const api = require('../main/api-client');

test('normalizeBaseUrl strips trailing slash, path suffixes and /v1', () => {
  assert.equal(api.normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com');
  assert.equal(api.normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(api.normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com');
  assert.equal(api.normalizeBaseUrl('https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com');
  assert.equal(api.normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com');
  assert.equal(api.normalizeBaseUrl(''), api.DEFAULT_BASE_URL);
  assert.equal(api.normalizeBaseUrl(null), api.DEFAULT_BASE_URL);
});

test('buildBody drops empty params and keeps numeric ones', () => {
  const body = api.buildBody({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: '0.5',
    topP: '',
    maxTokens: 100,
    stream: false
  });
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, 100);
  assert.equal(body.top_p, undefined);
  assert.equal(body.stream, false);
  assert.equal(body.messages.length, 1);
});

test('buildBody prepends system message when given', () => {
  const body = api.buildBody({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    system: 'be brief'
  });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'be brief');
});

test('buildBody does not duplicate existing system message', () => {
  const body = api.buildBody({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'a' },
      { role: 'user', content: 'hi' }
    ],
    system: 'b'
  });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].content, 'a');
});

test('buildBody strips params unsupported by deepseek-reasoner', () => {
  const body = api.buildBody({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 1.5,
    topP: 0.9,
    frequencyPenalty: 0.5,
    presencePenalty: 0.5,
    maxTokens: 512
  });
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  assert.equal(body.frequency_penalty, undefined);
  assert.equal(body.presence_penalty, undefined);
  assert.equal(body.max_tokens, 512); // max_tokens is still supported
});

test('buildBody enables include_usage for streams', () => {
  const body = api.buildBody({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true
  });
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('buildBody parses stop sequences', () => {
  const body = api.buildBody({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    stop: 'END, ###'
  });
  assert.deepEqual(body.stop, ['END', '###']);
});

test('extractSseEvents parses complete events and keeps partial tail', () => {
  const buf = 'data: {"choices":[{"delta":{"content":"He"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\n';
  const { events, rest, done } = api.extractSseEvents(buf);
  assert.equal(events.length, 2);
  assert.equal(events[0].choices[0].delta.content, 'He');
  assert.equal(events[1].choices[0].delta.content, 'llo');
  assert.equal(rest, '');
  assert.equal(done, false);
});

test('extractSseEvents handles partial chunk across reads', () => {
  const part1 = 'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"de';
  const r1 = api.extractSseEvents(part1);
  assert.equal(r1.events.length, 1);
  assert.ok(r1.rest.startsWith('data:'));
  const part2 = r1.rest + 'lta":{"content":"B"}}]}\n\n';
  const r2 = api.extractSseEvents(part2);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].choices[0].delta.content, 'B');
});

test('extractSseEvents stops at [DONE]', () => {
  const buf = 'data: {"usage":{"prompt_tokens":10}}\n\ndata: [DONE]\n\ndata: {"late":true}\n\n';
  const { events, done } = api.extractSseEvents(buf);
  assert.equal(done, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].usage.prompt_tokens, 10);
});

test('extractSseEvents tolerates CRLF line endings', () => {
  const buf = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';
  const { events } = api.extractSseEvents(buf);
  assert.equal(events.length, 2);
});

test('extractSseEvents ignores non-data lines and malformed json', () => {
  const buf = ': keepalive\n\ndata: not-json\n\ndata: {"ok":1}\n\n';
  const { events } = api.extractSseEvents(buf);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { ok: 1 });
});

test('normalizeUsage maps DeepSeek cache fields with fallbacks', () => {
  const u = api.normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    prompt_cache_hit_tokens: 60,
    prompt_cache_miss_tokens: 40
  });
  assert.equal(u.promptTokens, 100);
  assert.equal(u.completionTokens, 50);
  assert.equal(u.totalTokens, 150);
  assert.equal(u.cacheHitTokens, 60);
  assert.equal(u.cacheMissTokens, 40);

  // no cache fields: miss falls back to full prompt
  const u2 = api.normalizeUsage({ prompt_tokens: 30, completion_tokens: 10 });
  assert.equal(u2.cacheMissTokens, 30);
  assert.equal(u2.cacheHitTokens, 0);
  assert.equal(u2.totalTokens, 40);

  assert.deepEqual(api.normalizeUsage(null), {
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0
  });
});
