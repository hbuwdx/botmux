/**
 * Unit tests for the Open Platform avatar service: PNG validation, the
 * console-call chain (read base info → upload icon → write base_info with
 * `avatar` while preserving names for every language → mirror online
 * visibility into a new version → publish), and the structured failure
 * taxonomy shared with the rename service.
 *
 * Run: pnpm vitest run test/open-platform-avatar.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  AVATAR_IMAGE_MAX_BYTES,
  changeBotAvatarOnOpenPlatform,
  validateAvatarPng,
} from '../src/services/open-platform-rename.js';
import { type StoredCookie } from '../src/setup/open-platform-automation.js';

const COOKIES: StoredCookie[] = [{
  name: 'session', value: 'x', domain: 'feishu.cn', path: '/', secure: true, httpOnly: true, hostOnly: false,
}];

type Call = { kind: 'json' | 'form'; path: string; body: unknown };

/** Fake console client replaying canned responses per path prefix; records
 *  postJson and postForm calls in one ordered list. */
function fakeClient(calls: Call[], overrides: Record<string, unknown | ((body: unknown) => unknown)> = {}) {
  const respond = (kind: 'json' | 'form', path: string, body: unknown): unknown => {
    calls.push({ kind, path, body });
    for (const [prefix, resp] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) {
        const r = typeof resp === 'function' ? (resp as (b: unknown) => unknown)(body) : resp;
        if (r instanceof Error) throw r;
        return r;
      }
    }
    throw new Error(`unexpected console call: ${path}`);
  };
  return async (_cookies: StoredCookie[]) => ({
    ok: true as const,
    client: {
      apiOrigin: 'https://open.feishu.cn',
      async postJson(path: string, body?: unknown): Promise<unknown> {
        return respond('json', path, body);
      },
      async postForm(path: string, body: FormData): Promise<unknown> {
        return respond('form', path, body);
      },
    },
  });
}

/** Minimal buffer that satisfies validateAvatarPng: PNG magic + IHDR dims. */
function fakePng(width = 512, height = 512): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const BASE_INFO = {
  data: {
    name: '小助手',
    desc: '一个 bot',
    primaryLang: 'zh_cn',
    langs: ['zh_cn', 'en_us'],
    i18n: {
      zh_cn: { name: '小助手', description: '一个 bot', help_use: '' },
      en_us: { name: 'Helper', description: 'a bot' },
    },
  },
};

const ONLINE_VISIBLE = {
  data: {
    whiteList: { departments: [], groups: [], isAll: 0, members: [{ id: 'u1' }, { id: 'u2' }] },
    blackList: { departments: [], groups: [], isAll: 0, members: [{ id: 'u3' }] },
  },
};

const VERSION_LIST = { data: { versions: [{ appVersion: '1.0.4', versionStatus: 2 }] } };

const UPLOADED = { data: { url: 'https://s1-imfile.feishucdn.com/static-resource/v1/v3_new_avatar' } };

describe('validateAvatarPng', () => {
  it('accepts a 512×512 PNG', () => {
    expect(validateAvatarPng(fakePng())).toEqual({ ok: true });
  });

  it('rejects non-PNG bytes, wrong dimensions, and oversized buffers', () => {
    expect(validateAvatarPng(Buffer.from('not a png at all, definitely'))).toMatchObject({ ok: false });
    expect(validateAvatarPng(fakePng(256, 256))).toMatchObject({ ok: false });
    expect(validateAvatarPng(fakePng(512, 256))).toMatchObject({ ok: false });
    const huge = Buffer.alloc(AVATAR_IMAGE_MAX_BYTES + 1);
    fakePng().copy(huge, 0);
    expect(validateAvatarPng(huge)).toMatchObject({ ok: false });
  });
});

describe('changeBotAvatarOnOpenPlatform', () => {
  it('runs the full chain: upload icon, base_info with avatar + preserved names, version mirroring online visibility, publish', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/app/upload/image': UPLOADED,
        '/developers/v1/base_info/cli_x': { code: 0 },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-123' } },
        '/developers/v1/publish/commit/cli_x/v-123': { code: 0 },
      }),
    });

    expect(r).toMatchObject({ ok: true, avatarUrl: UPLOADED.data.url, versionId: 'v-123' });

    const uploadCall = calls.find(c => c.path.startsWith('/developers/v1/app/upload/image'))!;
    expect(uploadCall.kind).toBe('form');
    const form = uploadCall.body as FormData;
    expect(form.get('uploadType')).toBe('4');
    expect(form.get('isIsv')).toBe('false');
    expect(JSON.parse(String(form.get('scale')))).toEqual({ width: 512, height: 512 });
    expect((form.get('file') as Blob).size).toBe(fakePng().length);

    const baseInfoCall = calls.find(c => c.path.startsWith('/developers/v1/base_info/'))!;
    expect(baseInfoCall.body).toMatchObject({
      clientId: 'cli_x',
      // 名字/描述原样保留 —— 改头像绝不动名字。
      name: '小助手',
      desc: '一个 bot',
      languages: ['zh_cn', 'en_us'],
      i18n: {
        zh_cn: { name: '小助手', description: '一个 bot', help_use: '' },
        en_us: { name: 'Helper', description: 'a bot' },
      },
      avatar: UPLOADED.data.url,
    });

    const createCall = calls.find(c => c.path.startsWith('/developers/v1/app_version/create/'))!;
    expect(createCall.body).toMatchObject({
      appVersion: '1.0.5',
      visibleSuggest: { departments: [], groups: [], isAll: 0, members: ['u1', 'u2'] },
      blackVisibleSuggest: { departments: [], groups: [], isAll: 0, members: ['u3'] },
    });
    expect(calls.some(c => c.path === '/developers/v1/publish/commit/cli_x/v-123')).toBe(true);

    // 读取/解析（可见范围、版本列表）都发生在上传与第一笔写之前；上传本身
    // 也在 base_info 之前 —— 可见范围 fail-closed 时连图都不会传。
    const firstWrite = calls.findIndex(c => c.path.startsWith('/developers/v1/base_info/'));
    const uploadIdx = calls.findIndex(c => c.path.startsWith('/developers/v1/app/upload/image'));
    expect(calls.findIndex(c => c.path.startsWith('/developers/v1/visible/online/'))).toBeLessThan(uploadIdx);
    expect(calls.findIndex(c => c.path.startsWith('/developers/v1/app_version/list/'))).toBeLessThan(uploadIdx);
    expect(uploadIdx).toBeLessThan(firstWrite);
  });

  it('falls back to the top-level name for languages missing an i18n name', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': {
          data: {
            name: '小助手',
            desc: '',
            primaryLang: 'zh_cn',
            langs: ['zh_cn', 'ja_jp'],
            i18n: { zh_cn: { name: '小助手' }, ja_jp: { description: 'no name here' } },
          },
        },
        '/developers/v1/app/upload/image': UPLOADED,
        '/developers/v1/base_info/cli_x': { code: 0 },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-124' } },
        '/developers/v1/publish/commit/cli_x/v-124': { code: 0 },
      }),
    });
    expect(r).toMatchObject({ ok: true });
    const baseInfoCall = calls.find(c => c.path.startsWith('/developers/v1/base_info/'))!;
    expect(baseInfoCall.body).toMatchObject({
      i18n: {
        zh_cn: { name: '小助手' },
        ja_jp: { description: 'no name here', name: '小助手' },
      },
    });
  });

  it('rejects invalid images without touching cookies or the network', async () => {
    const calls: Call[] = [];
    let cookiesLoaded = 0;
    const r = await changeBotAvatarOnOpenPlatform('cli_x', Buffer.from('nope'), undefined, {
      loadCookies: () => { cookiesLoaded++; return COOKIES; },
      clientFactory: fakeClient(calls),
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_image' });
    expect(cookiesLoaded).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('aborts before any write when the current app name is unreadable', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': { data: { desc: 'no name field', langs: ['zh_cn'] } },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    if (!r.ok) expect(r.message).toContain('当前名称');
    expect(calls.every(c => !c.path.includes('/base_info/') && !c.path.includes('/app_version/create/') && !c.path.includes('/upload/image'))).toBe(true);
  });

  it('aborts before base_info when the upload returns no url', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/app/upload/image': { code: 0, data: {} },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    if (!r.ok) expect(r.message).toContain('url');
    expect(calls.every(c => !c.path.includes('/base_info/') && !c.path.includes('/app_version/create/'))).toBe(true);
  });

  it('fails closed BEFORE upload/mutation when a visibility entry shape is unrecognized', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/visible/online/cli_x': {
          data: {
            whiteList: { departments: [{ weirdKey: 'od-1' }], groups: [], isAll: 0, members: [] },
            blackList: { departments: [], groups: [], isAll: 0, members: [] },
          },
        },
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls.every(c => !c.path.includes('/upload/image') && !c.path.includes('/base_info/') && !c.path.includes('/publish/commit/'))).toBe(true);
  });

  it('rejects lark-brand tenants and reports no_session when cookies are absent', async () => {
    const calls: Call[] = [];
    const lark = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), 'lark', {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls),
    });
    expect(lark).toMatchObject({ ok: false, reason: 'unsupported_brand' });
    expect(calls).toHaveLength(0);

    const noSession = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => null,
      clientFactory: fakeClient(calls),
    });
    expect(noSession).toMatchObject({ ok: false, reason: 'no_session' });
  });
});
