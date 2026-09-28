// 拂尘 · Dusted — 酒馆批量清理插件
// 兼容 SillyTavern 1.14 – 1.19

const DAY = 86400000;
const IDLE_DAYS = 90;
const ZIP_PART_LIMIT = 80 * 1024 * 1024;
const LS_MODE = 'dusted-mode';
const LS_BACKUP = 'dusted-backup';

const C = () => SillyTavern.getContext();
const internals = {};

/* ---------------- 基础工具 ---------------- */

async function tryImport(path) {
    try { return await import(path); } catch { return null; }
}

async function loadInternals() {
    internals.script = await tryImport('../../../../script.js');
    internals.wi = await tryImport('../../../world-info.js');
    internals.personas = await tryImport('../../../personas.js');
}

function post(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: C().getRequestHeaders(),
        body: JSON.stringify(body || {}),
    });
}

async function getJSON(url, body) {
    const r = await post(url, body);
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
}

async function pool(list, n, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, list.length) }, async () => {
        while (i < list.length) {
            const item = list[i++];
            try { await fn(item); } catch (e) { console.warn('[Dusted]', e); }
        }
    });
    await Promise.all(workers);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileStem = (f) => String(f).replace(/\.[^.]+$/, '');
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');

function fmtSize(b) {
    b = Number(b) || 0;
    if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ms) {
    const d = Math.floor((Date.now() - ms) / DAY);
    if (d <= 0) return '今天';
    if (d === 1) return '昨天';
    if (d < 7) return `${d} 天前`;
    if (d < 30) return `${Math.floor(d / 7)} 周前`;
    if (d < 365) return `${Math.floor(d / 30)} 个月前`;
    return `${Math.floor(d / 365)} 年前`;
}

async function headSize(url) {
    try {
        const r = await fetch(url, { method: 'HEAD' });
        return Number(r.headers.get('content-length')) || 0;
    } catch { return 0; }
}

async function fetchBytes(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`下载失败：${url}`);
    return new Uint8Array(await r.arrayBuffer());
}

/* ---------------- 酒馆状态读取 ---------------- */

const powerUser = () => C().powerUserSettings || S.settings?.power_user || {};

function charLoreArr() {
    const wi = internals.wi?.world_info;
    return Array.isArray(wi?.charLore) ? wi.charLore : null;
}

function charLoreRead() {
    return charLoreArr() || S.settings?.world_info?.charLore || [];
}

function globalSelect() {
    const sel = internals.wi?.selected_world_info;
    if (Array.isArray(sel)) return sel;
    return S.settings?.world_info?.globalSelect || [];
}

function charLoreFor(avatar) {
    const e = charLoreRead().find((x) => x.name === fileStem(avatar));
    return Array.isArray(e?.extraBooks) ? e.extraBooks : [];
}

function currentCharAvatar() {
    const ctx = C();
    if (ctx.characterId === undefined || ctx.characterId === null) return null;
    return ctx.characters[Number(ctx.characterId)]?.avatar || null;
}

function currentPersona() {
    return internals.personas?.user_avatar || null;
}

function currentBg() {
    const el = document.getElementById('bg1');
    const s = el ? getComputedStyle(el).backgroundImage : '';
    if (!s) return '';
    for (const f of S.bgFiles) {
        if (s.includes(encodeURIComponent(f)) || s.includes(f)) return f;
    }
    return '';
}

function presetCurrent(apiId) {
    const ctx = C();
    const pu = powerUser();
    switch (apiId) {
        case 'openai': return ctx.chatCompletionSettings?.preset_settings_openai;
        case 'instruct': return pu.instruct?.preset;
        case 'context': return pu.context?.preset;
        case 'sysprompt': return pu.sysprompt?.name;
        case 'reasoning': return pu.reasoning?.name;
        default: return null;
    }
}

/* ---------------- 状态 ---------------- */

const TABS = [
    ['chars', '角色卡'],
    ['worlds', '世界书'],
    ['personas', '人设'],
    ['bgs', '背景'],
    ['themes', '主题'],
    ['presets', '预设'],
];

const S = {
    tab: 'chars',
    select: false,
    selected: new Set(),
    search: '',
    onlyIdle: { chars: false, worlds: false, personas: false },
    sortSize: false,
    settings: null,
    worldNames: [],
    avatars: [],
    bgFiles: [],
    themes: [],
    presets: [],
    full: new Map(),
    worldCounts: new Map(),
    scanning: false,
    scanDone: 0,
    scanTotal: 0,
    items: [],
    busy: false,
};

async function loadData() {
    const res = await getJSON('/api/settings/get');
    try { S.settings = JSON.parse(res.settings); } catch { S.settings = {}; }
    S.worldNames = Array.isArray(res.world_names) ? res.world_names : [];
    S.themes = Array.isArray(res.themes) ? res.themes.filter((t) => t?.name) : [];
    S.presets = collectPresets(res);

    const [avatars, bgs] = await Promise.all([
        getJSON('/api/avatars/get').catch(() => []),
        getJSON('/api/backgrounds/all').catch(() => []),
    ]);
    S.avatars = Array.isArray(avatars) ? avatars : [];
    const bgList = Array.isArray(bgs) ? bgs : (bgs?.images || []);
    S.bgFiles = bgList.map((x) => (typeof x === 'string' ? x : (x?.filename || x?.name))).filter(Boolean);
}

function collectPresets(res) {
    const out = [];
    const pairs = [
        ['openai', '对话补全', res.openai_setting_names, res.openai_settings],
        ['textgenerationwebui', '文本补全', res.textgenerationwebui_preset_names, res.textgenerationwebui_presets],
    ];
    for (const [apiId, label, names, datas] of pairs) {
        if (!Array.isArray(names)) continue;
        names.forEach((name, i) => out.push({ apiId, label, name, data: Array.isArray(datas) ? datas[i] : null }));
    }
    const objs = [
        ['instruct', '指令模板', res.instruct],
        ['context', '上下文模板', res.context],
        ['sysprompt', '系统提示词', res.sysprompt],
        ['reasoning', '推理格式', res.reasoning],
    ];
    for (const [apiId, label, arr] of objs) {
        if (!Array.isArray(arr)) continue;
        arr.filter((x) => x?.name).forEach((x) => out.push({ apiId, label, name: x.name, data: x }));
    }
    return out;
}

async function scanCharacters() {
    if (S.scanning) return;
    const chars = C().characters.filter((c) => c?.avatar && !S.full.has(c.avatar));
    if (!chars.length) return;
    S.scanning = true;
    S.scanDone = 0;
    S.scanTotal = chars.length;
    renderHeader();
    await pool(chars, 4, async (c) => {
        let full = c;
        if (c.shallow || !c.data?.extensions) {
            try { full = await getJSON('/api/characters/get', { avatar_url: c.avatar }); } catch { full = c; }
        }
        const ext = full?.data?.extensions || {};
        S.full.set(c.avatar, {
            world: ext.world || '',
            regex: Array.isArray(ext.regex_scripts) ? ext.regex_scripts.length : 0,
        });
        S.scanDone++;
        if (S.scanDone % 6 === 0) renderHeader();
    });
    S.scanning = false;
    renderHeader();
    renderList();
}

async function scanWorldCounts() {
    const todo = S.worldNames.filter((n) => !S.worldCounts.has(n));
    await pool(todo, 4, async (name) => {
        const data = await getJSON('/api/worldinfo/get', { name });
        S.worldCounts.set(name, Object.keys(data?.entries || {}).length);
    });
    if (S.tab === 'worlds') renderList();
}

function worldRefs(excludeAvatars = new Set()) {
    const refs = new Map();
    const add = (w, t) => {
        if (!w) return;
        if (!refs.has(w)) refs.set(w, []);
        refs.get(w).push(t);
    };
    const chars = C().characters.filter((c) => c?.avatar);
    for (const c of chars) {
        if (excludeAvatars.has(c.avatar)) continue;
        const f = S.full.get(c.avatar);
        if (f?.world) add(f.world, `角色卡「${c.name}」`);
    }
    const byStem = new Map(chars.map((c) => [fileStem(c.avatar), c]));
    for (const e of charLoreRead()) {
        const c = byStem.get(e.name);
        if (!c || excludeAvatars.has(c.avatar)) continue;
        for (const b of e.extraBooks || []) add(b, `角色卡「${c.name}」的附加世界书`);
    }
    for (const w of globalSelect()) add(w, '全局启用');
    const pu = powerUser();
    for (const [av, d] of Object.entries(pu.persona_descriptions || {})) {
        if (d?.lorebook) add(d.lorebook, `人设「${pu.personas?.[av] || av}」`);
    }
    const chatWorld = C().chatMetadata?.world_info;
    if (chatWorld) add(chatWorld, '当前聊天');
    return refs;
}

/* ---------------- 各分区条目 ---------------- */

function itemsFor(tab) {
    const pu = powerUser();
    switch (tab) {
        case 'chars': {
            const cur = currentCharAvatar();
            return C().characters.filter((c) => c?.avatar).map((c) => {
                const last = Number(c.date_last_chat) || 0;
                const idle = !last || Date.now() - last > IDLE_DAYS * DAY;
                const size = (Number(c.data_size) || 0) + (Number(c.chat_size) || 0);
                return {
                    id: c.avatar, name: c.name || c.avatar,
                    thumb: `/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}`,
                    meta: `${fmtSize(size)} · ${last ? ago(last) : '从未聊过'}`,
                    idle, size, badge: idle ? '闲置' : '',
                    locked: c.avatar === cur ? '正在聊天中，先切到别的角色再删' : '',
                };
            });
        }
        case 'worlds': {
            const refs = worldRefs();
            return S.worldNames.map((n) => {
                const r = refs.get(n) || [];
                const cnt = S.worldCounts.get(n);
                let meta = r.length === 0 ? '没有绑定' : r.length === 1 ? r[0] : `${r[0]} 等 ${r.length} 处`;
                if (cnt !== undefined) meta += ` · ${cnt} 条目`;
                return { id: n, name: n, meta, refs: r, idle: r.length === 0, badge: r.length === 0 && !S.scanning ? '未绑定' : '', locked: '' };
            });
        }
        case 'personas': {
            const cur = currentPersona();
            return S.avatars.map((av) => {
                const d = pu.persona_descriptions?.[av] || {};
                const conn = Array.isArray(d.connections) ? d.connections.length : 0;
                const isDef = pu.default_persona === av;
                const used = isDef || conn > 0 || av === cur;
                return {
                    id: av, name: pu.personas?.[av] || av,
                    thumb: `/thumbnail?type=persona&file=${encodeURIComponent(av)}`,
                    meta: isDef ? '默认人设' : conn ? `关联 ${conn} 个角色` : '没有关联角色',
                    idle: !used, badge: av === cur ? '正在使用' : (!used ? '闲置' : ''),
                    locked: av === cur ? '正在使用中，先切到别的人设再删' : '',
                };
            });
        }
        case 'bgs': {
            const cur = currentBg();
            return S.bgFiles.map((f) => ({
                id: f, name: fileStem(f),
                thumb: `/thumbnail?type=bg&file=${encodeURIComponent(f)}`,
                meta: f, idle: f !== cur, badge: f === cur ? '正在使用' : '',
                locked: f === cur ? '正在使用中，先换一张背景再删' : '',
            }));
        }
        case 'themes': {
            return S.themes.map((t) => ({
                id: t.name, name: t.name,
                meta: t.name === pu.theme ? '当前主题' : '美化主题',
                idle: t.name !== pu.theme, badge: t.name === pu.theme ? '正在使用' : '',
                locked: t.name === pu.theme ? '正在使用中，先换一个主题再删' : '',
            }));
        }
        case 'presets': {
            return S.presets.map((p) => {
                const cur = presetCurrent(p.apiId) === p.name;
                return {
                    id: `${p.apiId}::${p.name}`, name: p.name, meta: p.label,
                    idle: !cur, badge: cur ? '正在使用' : '',
                    locked: cur ? '正在使用中，先换一个再删' : '',
                };
            });
        }
    }
    return [];
}

function visibleItems() {
    let items = itemsFor(S.tab);
    const q = S.search.trim().toLowerCase();
    if (q) items = items.filter((x) => x.name.toLowerCase().includes(q) || String(x.meta).toLowerCase().includes(q));
    if (S.onlyIdle[S.tab]) items = items.filter((x) => x.idle);
    if (S.tab === 'chars' && S.sortSize) items.sort((a, b) => b.size - a.size);
    return items;
}

/* ---------------- ZIP（仅存储，不压缩） ---------------- */

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

class Zip {
    constructor() { this.files = []; this.size = 0; this.names = new Set(); }
    add(name, data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        let n = name, i = 1;
        while (this.names.has(n)) n = name.replace(/(\.[^./]+)?$/, `_${i++}$1`);
        this.names.add(n);
        this.files.push({ name: n, bytes });
        this.size += bytes.length;
    }
    build() {
        const enc = new TextEncoder();
        const d = new Date();
        const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        const parts = [], central = [];
        let offset = 0;
        for (const f of this.files) {
            const nb = enc.encode(f.name), crc = crc32(f.bytes), sz = f.bytes.length;
            const h = new DataView(new ArrayBuffer(30));
            h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
            h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
            h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true);
            h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
            parts.push(h.buffer, nb, f.bytes);
            const c = new DataView(new ArrayBuffer(46));
            c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
            c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true);
            c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, sz, true);
            c.setUint32(24, sz, true); c.setUint16(28, nb.length, true);
            c.setUint32(42, offset, true);
            central.push(c.buffer, nb);
            offset += 30 + nb.length + sz;
        }
        const cd = central.reduce((a, b) => a + b.byteLength, 0);
        const e = new DataView(new ArrayBuffer(22));
        e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.files.length, true);
        e.setUint16(10, this.files.length, true); e.setUint32(12, cd, true); e.setUint32(16, offset, true);
        return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
    }
}

class Backup {
    constructor() { this.zips = [new Zip()]; }
    add(name, data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        let z = this.zips[this.zips.length - 1];
        if (z.files.length && z.size + bytes.length > ZIP_PART_LIMIT) {
            z = new Zip();
            this.zips.push(z);
        }
        z.add(name, bytes);
    }
    async download() {
        const d = new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
        for (let i = 0; i < this.zips.length; i++) {
            const z = this.zips[i];
            z.add('说明.txt', '拂尘备份\n\n角色卡是 png，世界书、主题、预设是 json，聊天记录是 jsonl。\n想找回时，用酒馆自带的导入功能导入对应文件即可。\n背景图和人设头像直接重新上传。\n');
            const suffix = this.zips.length > 1 ? `-${i + 1}of${this.zips.length}` : '';
            const url = URL.createObjectURL(z.build());
            const a = document.createElement('a');
            a.href = url;
            a.download = `拂尘备份-${stamp}${suffix}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            await new Promise((r) => setTimeout(r, 800));
        }
    }
}

/* ---------------- 删除计划 ---------------- */

async function planFor(tab, ids) {
    switch (tab) {
        case 'chars': return planChars(ids);
        case 'worlds': return planWorlds(ids);
        case 'personas': return planPersonas(ids);
        case 'bgs': return planBgs(ids);
        case 'themes': return planThemes(ids);
        case 'presets': return planPresets(ids);
    }
}

function nameList(names, unit) {
    if (names.length === 1) return `「${names[0]}」`;
    return ` ${names.length} ${unit}`;
}

async function planChars(ids) {
    const chars = ids.map((id) => C().characters.find((c) => c.avatar === id)).filter(Boolean);
    const ex = new Set(ids);
    const refsAfter = worldRefs(ex);
    const worlds = new Set();
    const keptMap = new Map();
    const chatLists = new Map();
    let size = 0, chatCount = 0, regex = 0, tags = 0;
    const groups = new Set();
    const allowed = C().extensionSettings?.character_allowed_regex || [];
    let allowCount = 0;

    await pool(chars, 4, async (c) => {
        let list = [];
        try {
            const r = await getJSON('/api/characters/chats', { avatar_url: c.avatar, simple: true });
            list = (Array.isArray(r) ? r : Object.values(r || {})).filter((x) => x?.file_name);
        } catch { /* 没有聊天 */ }
        chatLists.set(c.avatar, list);
    });

    for (const c of chars) {
        const f = S.full.get(c.avatar) || {};
        size += (Number(c.data_size) || 0) + (Number(c.chat_size) || 0);
        chatCount += chatLists.get(c.avatar).length;
        regex += f.regex || 0;
        if (allowed.includes(c.avatar)) allowCount++;
        for (const b of [f.world, ...charLoreFor(c.avatar)].filter(Boolean)) {
            if (!S.worldNames.includes(b)) continue;
            const r = refsAfter.get(b);
            if (r?.length) keptMap.set(b, `还被${r[0]}使用`);
            else worlds.add(b);
        }
        for (const g of C().groups || []) if (g.members?.includes(c.avatar)) groups.add(g.id);
        tags += (C().tagMap?.[c.avatar] || []).length;
    }

    const gone = [{ label: '角色卡文件', meta: `${chars.length} 张` }];
    if (chatCount) gone.push({ label: `聊天记录 ${chatCount} 个`, meta: fmtSize(chars.reduce((a, c) => a + (Number(c.chat_size) || 0), 0)) });
    for (const w of worlds) gone.push({ label: `世界书「${w}」`, meta: '随卡导入' });
    if (regex) gone.push({ label: '卡内正则', meta: `${regex} 条` });
    if (allowCount) gone.push({ label: '正则授权记录', meta: `${allowCount} 条` });
    if (tags) gone.push({ label: '标签关联', meta: `${tags} 个` });
    if (groups.size) gone.push({ label: '从群聊中移出', meta: `${groups.size} 个群` });
    gone.push({ label: '缩略图缓存', meta: '' });

    const kept = [...keptMap].map(([w, reason]) => ({ label: `世界书「${w}」`, reason }));

    return {
        title: `删除${nameList(chars.map((c) => c.name), '张角色卡')}？`,
        gone, kept, size,
        backup: async (bk, step) => {
            for (const c of chars) {
                step(`备份「${c.name}」`);
                bk.add(`角色卡/${c.avatar}`, await fetchBytes(`/characters/${encodeURIComponent(c.avatar)}`));
                for (const ch of chatLists.get(c.avatar)) {
                    const fileName = String(ch.file_name).replace(/\.jsonl$/, '');
                    const msgs = await getJSON('/api/chats/get', { ch_name: c.name, file_name: fileName, avatar_url: c.avatar });
                    bk.add(`聊天记录/${safeName(c.name)}/${safeName(fileName)}.jsonl`, (msgs || []).map((m) => JSON.stringify(m)).join('\n'));
                }
            }
            for (const w of worlds) {
                bk.add(`世界书/${safeName(w)}.json`, JSON.stringify(await getJSON('/api/worldinfo/get', { name: w }), null, 4));
            }
        },
        run: async (step) => {
            for (const c of chars) {
                step(`删除「${c.name}」`);
                const r = await post('/api/characters/delete', { avatar_url: c.avatar, delete_chats: true });
                if (!r.ok) continue;
                await cleanupCharRefs(c.avatar);
                S.full.delete(c.avatar);
            }
            for (const w of worlds) {
                step(`删除世界书「${w}」`);
                await deleteWorld(w);
            }
            C().saveSettingsDebounced();
            const refresh = C().getCharacters || internals.script?.getCharacters;
            if (typeof refresh === 'function') await refresh();
        },
        verify: async () => {
            const fails = [];
            const all = await getJSON('/api/characters/all').catch(() => null);
            if (Array.isArray(all)) {
                const left = new Set(all.map((x) => x.avatar));
                for (const c of chars) if (left.has(c.avatar)) fails.push(`角色卡「${c.name}」`);
            }
            await loadData();
            for (const w of worlds) if (S.worldNames.includes(w)) fails.push(`世界书「${w}」`);
            return fails;
        },
    };
}

async function cleanupCharRefs(avatar) {
    const ctx = C();
    if (ctx.tagMap && avatar in ctx.tagMap) delete ctx.tagMap[avatar];
    const es = ctx.extensionSettings;
    if (Array.isArray(es?.character_allowed_regex)) {
        es.character_allowed_regex = es.character_allowed_regex.filter((x) => x !== avatar);
    }
    const lore = charLoreArr();
    if (lore) {
        const i = lore.findIndex((e) => e.name === fileStem(avatar));
        if (i >= 0) lore.splice(i, 1);
    }
    for (const d of Object.values(powerUser().persona_descriptions || {})) {
        if (Array.isArray(d?.connections)) d.connections = d.connections.filter((x) => !(x?.type === 'character' && x?.id === avatar));
    }
    for (const g of ctx.groups || []) {
        if (!g.members?.includes(avatar)) continue;
        const updated = {
            ...g,
            members: g.members.filter((m) => m !== avatar),
            disabled_members: (g.disabled_members || []).filter((m) => m !== avatar),
        };
        const r = await post('/api/groups/edit', updated);
        if (r.ok) { g.members = updated.members; g.disabled_members = updated.disabled_members; }
    }
}

async function deleteWorld(name) {
    let ok = false;
    if (typeof internals.wi?.deleteWorldInfo === 'function') {
        try { ok = await internals.wi.deleteWorldInfo(name); } catch { ok = false; }
    }
    if (!ok) {
        const r = await post('/api/worldinfo/delete', { name });
        ok = r.ok;
    }
    const sel = internals.wi?.selected_world_info;
    if (Array.isArray(sel)) {
        const i = sel.indexOf(name);
        if (i >= 0) sel.splice(i, 1);
    }
    const lore = charLoreArr();
    if (lore) for (const e of lore) if (Array.isArray(e.extraBooks)) e.extraBooks = e.extraBooks.filter((b) => b !== name);
    for (const d of Object.values(powerUser().persona_descriptions || {})) if (d?.lorebook === name) d.lorebook = '';
    S.worldCounts.delete(name);
    return ok;
}

async function planWorlds(ids) {
    const refs = worldRefs();
    const gone = ids.map((n) => {
        const r = refs.get(n) || [];
        return { label: `世界书「${n}」`, meta: r.length ? `${r[0]}会失去它` : `${S.worldCounts.get(n) ?? '?'} 条目`, warn: r.length > 0 };
    });
    return {
        title: `删除${nameList(ids, '本世界书')}？`,
        gone, kept: [], size: 0,
        backup: async (bk, step) => {
            for (const n of ids) {
                step(`备份「${n}」`);
                bk.add(`世界书/${safeName(n)}.json`, JSON.stringify(await getJSON('/api/worldinfo/get', { name: n }), null, 4));
            }
        },
        run: async (step) => {
            for (const n of ids) { step(`删除「${n}」`); await deleteWorld(n); }
            C().saveSettingsDebounced();
        },
        verify: async () => {
            await loadData();
            return ids.filter((n) => S.worldNames.includes(n)).map((n) => `世界书「${n}」`);
        },
    };
}

async function planPersonas(ids) {
    const pu = powerUser();
    const names = ids.map((av) => pu.personas?.[av] || av);
    let size = 0;
    await pool(ids, 4, async (av) => { size += await headSize(`/User%20Avatars/${encodeURIComponent(av)}`); });
    return {
        title: `删除${nameList(names, '个人设')}？`,
        gone: [
            { label: '人设头像', meta: `${ids.length} 个` },
            { label: '人设描述和角色关联', meta: '' },
        ],
        kept: [], size,
        backup: async (bk, step) => {
            const desc = {};
            for (const av of ids) {
                step(`备份「${pu.personas?.[av] || av}」`);
                bk.add(`人设/${av}`, await fetchBytes(`/User%20Avatars/${encodeURIComponent(av)}`));
                desc[av] = { name: pu.personas?.[av], ...(pu.persona_descriptions?.[av] || {}) };
            }
            bk.add('人设/人设描述.json', JSON.stringify(desc, null, 4));
        },
        run: async (step) => {
            for (const av of ids) {
                step(`删除「${pu.personas?.[av] || av}」`);
                const r = await post('/api/avatars/delete', { avatar: av });
                if (!r.ok) continue;
                if (pu.personas) delete pu.personas[av];
                if (pu.persona_descriptions) delete pu.persona_descriptions[av];
                if (pu.default_persona === av) pu.default_persona = null;
            }
            C().saveSettingsDebounced();
        },
        verify: async () => {
            await loadData();
            return ids.filter((av) => S.avatars.includes(av)).map((av) => `人设「${pu.personas?.[av] || av}」`);
        },
    };
}

async function planBgs(ids) {
    let size = 0;
    await pool(ids, 4, async (f) => { size += await headSize(`/backgrounds/${encodeURIComponent(f)}`); });
    return {
        title: `删除${nameList(ids.map(fileStem), '张背景图')}？`,
        gone: [{ label: '背景图文件', meta: `${ids.length} 张 · ${fmtSize(size)}` }, { label: '缩略图缓存', meta: '' }],
        kept: [], size,
        note: '锁定在某个聊天里的背景检测不到，删掉后那个聊天会变回默认背景。',
        backup: async (bk, step) => {
            for (const f of ids) {
                step(`备份「${f}」`);
                bk.add(`背景图/${f}`, await fetchBytes(`/backgrounds/${encodeURIComponent(f)}`));
            }
        },
        run: async (step) => {
            for (const f of ids) { step(`删除「${f}」`); await post('/api/backgrounds/delete', { bg: f }); }
        },
        verify: async () => {
            await loadData();
            return ids.filter((f) => S.bgFiles.includes(f)).map((f) => `背景图「${f}」`);
        },
    };
}

async function planThemes(ids) {
    return {
        title: `删除${nameList(ids, '个主题')}？`,
        gone: ids.map((n) => ({ label: `主题「${n}」`, meta: '' })),
        kept: [], size: 0,
        backup: async (bk) => {
            for (const n of ids) {
                const t = S.themes.find((x) => x.name === n);
                if (t) bk.add(`主题/${safeName(n)}.json`, JSON.stringify(t, null, 4));
            }
        },
        run: async (step) => {
            for (const n of ids) { step(`删除「${n}」`); await post('/api/themes/delete', { name: n }); }
        },
        verify: async () => {
            await loadData();
            return ids.filter((n) => S.themes.some((t) => t.name === n)).map((n) => `主题「${n}」`);
        },
    };
}

async function planPresets(ids) {
    const list = ids.map((id) => S.presets.find((p) => `${p.apiId}::${p.name}` === id)).filter(Boolean);
    return {
        title: `删除${nameList(list.map((p) => p.name), '个预设')}？`,
        gone: list.map((p) => ({ label: `「${p.name}」`, meta: p.label })),
        kept: [], size: 0,
        backup: async (bk) => {
            for (const p of list) {
                let data = p.data;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* 原样保存 */ } }
                bk.add(`预设/${p.label}/${safeName(p.name)}.json`, typeof data === 'string' ? data : JSON.stringify(data, null, 4));
            }
        },
        run: async (step) => {
            for (const p of list) { step(`删除「${p.name}」`); await post('/api/presets/delete', { name: p.name, apiId: p.apiId }); }
        },
        verify: async () => {
            await loadData();
            return list.filter((p) => S.presets.some((x) => x.apiId === p.apiId && x.name === p.name)).map((p) => `预设「${p.name}」`);
        },
    };
}

/* ---------------- 界面 ---------------- */

let root = null;
const $d = (sel) => root.querySelector(sel);

const ICON = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L19 7"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="11" width="12" height="9" rx="1.5"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/></svg>',
    brush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v7"/><path d="M8 10h8l1 11H7z"/></svg>',
};

function resolvedMode() {
    const m = localStorage.getItem(LS_MODE);
    if (m === 'day' || m === 'night') return m;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'day' : 'night';
}

function applyMode() { if (root) root.dataset.mode = resolvedMode(); }

function toast(msg) {
    const t = document.createElement('div');
    t.className = 'd-toast';
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.remove(), 2200);
}

async function openPanel() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'dusted-root';
    root.innerHTML = `
        <div class="d-panel">
            <div class="d-header"></div>
            <div class="d-tabs" role="tablist"></div>
            <div class="d-toolbar"></div>
            <div class="d-list"></div>
            <div class="d-bar"></div>
        </div>
        <div class="d-sheet-wrap" hidden><div class="d-sheet"></div></div>`;
    document.body.appendChild(root);
    applyMode();
    bindList();
    $d('.d-list').innerHTML = '<div class="d-empty">正在读取酒馆数据…</div>';
    renderHeader();
    renderTabs();
    renderToolbar();
    try {
        await loadData();
    } catch (e) {
        $d('.d-list').innerHTML = `<div class="d-empty">读取失败：${esc(e.message)}</div>`;
        return;
    }
    renderAll();
    scanCharacters();
}

function closePanel() {
    root?.remove();
    root = null;
    S.select = false;
    S.selected.clear();
}

function renderAll() {
    renderHeader();
    renderTabs();
    renderToolbar();
    renderList();
    renderBar();
}

function renderHeader() {
    if (!root) return;
    const h = $d('.d-header');
    const mode = resolvedMode();
    if (S.select) {
        h.innerHTML = `
            <button class="d-textbtn" data-act="cancel-select">取消</button>
            <div class="d-title-sm">已选 ${S.selected.size} 项</div>
            <button class="d-textbtn d-accent-text" data-act="select-idle">全选闲置</button>`;
    } else {
        const label = TABS.find((t) => t[0] === S.tab)[1];
        const count = S.items.length;
        let sub = `${label} ${count}`;
        if (S.scanning) sub += ` · 正在清点引用 ${S.scanDone}/${S.scanTotal}`;
        h.innerHTML = `
            <div class="d-titles">
                <div class="d-title">拂尘</div>
                <div class="d-sub">${esc(sub)}</div>
            </div>
            <div class="d-head-btns">
                <button class="d-iconbtn" data-act="enter-select" aria-label="多选">${ICON.check}</button>
                <button class="d-iconbtn" data-act="mode" aria-label="切换日间/夜间">${mode === 'night' ? ICON.sun : ICON.moon}</button>
                <button class="d-iconbtn" data-act="close" aria-label="关闭">${ICON.close}</button>
            </div>`;
    }
    h.onclick = onHeaderClick;
}

function onHeaderClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closePanel();
    if (act === 'mode') {
        localStorage.setItem(LS_MODE, resolvedMode() === 'night' ? 'day' : 'night');
        applyMode();
        renderHeader();
    }
    if (act === 'enter-select') { S.select = true; renderHeader(); renderList(); renderBar(); }
    if (act === 'cancel-select') { S.select = false; S.selected.clear(); renderHeader(); renderList(); renderBar(); }
    if (act === 'select-idle') {
        for (const it of S.items) if (it.idle && !it.locked) S.selected.add(it.id);
        refreshSelection();
    }
}

function renderTabs() {
    const t = $d('.d-tabs');
    t.innerHTML = TABS.map(([id, label]) =>
        `<button class="d-tab${S.tab === id ? ' is-on' : ''}" role="tab" aria-selected="${S.tab === id}" data-tab="${id}">${label}</button>`).join('');
    t.onclick = (e) => {
        const id = e.target.closest('[data-tab]')?.dataset.tab;
        if (!id || id === S.tab) return;
        S.tab = id;
        S.select = false;
        S.selected.clear();
        S.search = '';
        renderAll();
        if (id === 'worlds') scanWorldCounts();
    };
}

function renderToolbar() {
    const tb = $d('.d-toolbar');
    const chips = [];
    if (S.tab in S.onlyIdle) {
        const label = S.tab === 'worlds' ? '只看未绑定' : '只看闲置';
        chips.push(`<button class="d-chip${S.onlyIdle[S.tab] ? ' is-on' : ''}" data-chip="idle">${S.onlyIdle[S.tab] ? ICON.check : ''}${label}</button>`);
    }
    if (S.tab === 'chars') chips.push(`<button class="d-chip${S.sortSize ? ' is-on' : ''}" data-chip="size">${S.sortSize ? ICON.check : ''}按大小</button>`);
    tb.innerHTML = `
        <label class="d-search">${ICON.search}<input type="search" placeholder="搜索" value="${esc(S.search)}"></label>
        ${chips.length ? `<div class="d-chips">${chips.join('')}</div>` : ''}`;
    const input = tb.querySelector('input');
    input.oninput = () => { S.search = input.value; renderList(); renderHeader(); };
    tb.onclick = (e) => {
        const c = e.target.closest('[data-chip]')?.dataset.chip;
        if (c === 'idle') S.onlyIdle[S.tab] = !S.onlyIdle[S.tab];
        if (c === 'size') S.sortSize = !S.sortSize;
        if (c) { renderToolbar(); renderList(); renderHeader(); }
    };
}

const GRID_TABS = { chars: 'd-grid-card', personas: 'd-grid-square', bgs: 'd-grid-wide' };

function renderList() {
    if (!root) return;
    S.items = visibleItems();
    const list = $d('.d-list');
    if (!S.items.length) {
        list.className = 'd-list';
        list.innerHTML = `<div class="d-empty">${S.search || S.onlyIdle[S.tab] ? '没有符合条件的' : '这里是空的'}</div>`;
        return;
    }
    const grid = GRID_TABS[S.tab];
    list.className = `d-list ${grid ? `d-grid ${grid}` : 'd-rows'}${S.select ? ' is-selecting' : ''}`;
    list.innerHTML = S.items.map((it) => grid ? gridItem(it) : rowItem(it)).join('')
        + (S.tab === 'bgs' ? '<div class="d-hint">锁定在某个聊天里的背景检测不到，删前留意。</div>' : '')
        + (!S.select ? '<div class="d-hint">长按任意一项进入多选</div>' : '');
    refreshSelection();
}

function gridItem(it) {
    return `
        <button class="d-item" data-id="${esc(it.id)}">
            <span class="d-thumb"><img src="${esc(it.thumb)}" alt="" loading="lazy" draggable="false">
                ${it.badge ? `<span class="d-badge${it.locked ? ' is-use' : ''}">${esc(it.badge)}</span>` : ''}
                <span class="d-check">${ICON.check}</span>
            </span>
            <span class="d-name">${esc(it.name)}</span>
            <span class="d-meta">${esc(it.meta)}</span>
        </button>`;
}

function rowItem(it) {
    const icon = S.tab === 'worlds' ? ICON.book : ICON.brush;
    return `
        <button class="d-item d-row" data-id="${esc(it.id)}">
            <span class="d-row-icon">${icon}</span>
            <span class="d-row-main">
                <span class="d-row-top"><span class="d-name">${esc(it.name)}</span>${it.badge ? `<span class="d-tag${it.locked ? ' is-use' : ''}">${esc(it.badge)}</span>` : ''}</span>
                <span class="d-meta">${esc(it.meta)}</span>
            </span>
            <span class="d-box">${ICON.check}</span>
        </button>`;
}

function refreshSelection() {
    if (!root) return;
    root.querySelectorAll('.d-item').forEach((el) => el.classList.toggle('is-picked', S.selected.has(el.dataset.id)));
    renderBar();
    if (S.select) renderHeader();
}

function renderBar() {
    const bar = $d('.d-bar');
    if (!S.select) { bar.innerHTML = ''; bar.hidden = true; return; }
    bar.hidden = false;
    let sizeText = '';
    if (S.tab === 'chars') {
        const sum = [...S.selected].reduce((a, id) => {
            const c = C().characters.find((x) => x.avatar === id);
            return a + (Number(c?.data_size) || 0) + (Number(c?.chat_size) || 0);
        }, 0);
        if (sum) sizeText = `约 ${fmtSize(sum)}`;
    }
    bar.innerHTML = `
        <div class="d-bar-info"><div class="d-bar-count">已选 ${S.selected.size} 项</div>${sizeText ? `<div class="d-bar-size">${sizeText}</div>` : ''}</div>
        <button class="d-btn d-btn-danger" data-act="delete" ${S.selected.size ? '' : 'disabled'}>删除</button>`;
    bar.onclick = (e) => {
        if (e.target.closest('[data-act="delete"]') && S.selected.size) openConfirm([...S.selected]);
    };
}

function bindList() {
    const list = $d('.d-list');
    let timer = null, pressed = false, sx = 0, sy = 0;
    list.addEventListener('pointerdown', (e) => {
        const el = e.target.closest('.d-item');
        if (!el) return;
        pressed = false;
        sx = e.clientX; sy = e.clientY;
        timer = setTimeout(() => {
            pressed = true;
            const it = S.items.find((x) => x.id === el.dataset.id);
            if (!S.select) { S.select = true; renderHeader(); list.classList.add('is-selecting'); }
            if (it && !it.locked) S.selected.add(it.id);
            else if (it?.locked) toast(it.locked);
            refreshSelection();
            navigator.vibrate?.(15);
        }, 450);
    });
    const clear = () => { clearTimeout(timer); timer = null; };
    list.addEventListener('pointerup', clear);
    list.addEventListener('pointercancel', clear);
    list.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 10) clear(); });
    list.addEventListener('contextmenu', (e) => { if (e.target.closest('.d-item')) e.preventDefault(); });
    list.addEventListener('click', (e) => {
        const el = e.target.closest('.d-item');
        if (!el) return;
        if (pressed) { pressed = false; return; }
        const it = S.items.find((x) => x.id === el.dataset.id);
        if (!it) return;
        if (S.select) {
            if (it.locked) { toast(it.locked); return; }
            S.selected.has(it.id) ? S.selected.delete(it.id) : S.selected.add(it.id);
            refreshSelection();
        } else {
            openDetail(it);
        }
    });
}

/* ---------------- 弹层 ---------------- */

function showSheet(html) {
    const wrap = $d('.d-sheet-wrap');
    const sheet = $d('.d-sheet');
    sheet.innerHTML = `<div class="d-grabber"></div>${html}`;
    wrap.hidden = false;
    wrap.onclick = (e) => { if (e.target === wrap && !S.busy) hideSheet(); };
    return sheet;
}

function hideSheet() {
    const wrap = $d('.d-sheet-wrap');
    if (wrap) wrap.hidden = true;
}

function detailLines(it) {
    const lines = [];
    if (S.tab === 'chars') {
        const f = S.full.get(it.id);
        const lore = charLoreFor(it.id);
        if (!f) lines.push(['引用', '还在清点中']);
        else {
            lines.push(['绑定世界书', f.world || '无']);
            if (lore.length) lines.push(['附加世界书', lore.join('、')]);
            lines.push(['卡内正则', f.regex ? `${f.regex} 条` : '无']);
        }
        const groups = (C().groups || []).filter((g) => g.members?.includes(it.id)).map((g) => g.name);
        if (groups.length) lines.push(['所在群聊', groups.join('、')]);
    }
    if (S.tab === 'worlds') {
        lines.push(['条目', S.worldCounts.has(it.id) ? `${S.worldCounts.get(it.id)} 条` : '统计中']);
        lines.push(['被谁使用', it.refs?.length ? it.refs.join('\n') : '没有']);
    }
    if (!lines.length) lines.push(['信息', it.meta]);
    return lines;
}

function openDetail(it) {
    const thumb = it.thumb ? `<img class="d-detail-img d-detail-${S.tab}" src="${esc(it.thumb)}" alt="">` : '';
    const sheet = showSheet(`
        <div class="d-detail-head">${thumb}<div><div class="d-sheet-title">${esc(it.name)}</div><div class="d-sub">${esc(it.meta)}</div></div></div>
        <div class="d-card">${detailLines(it).map(([k, v]) => `<div class="d-kv"><span>${esc(k)}</span><span class="d-kv-v">${esc(v)}</span></div>`).join('')}</div>
        ${it.locked ? `<div class="d-note">${esc(it.locked)}</div>` : ''}
        <div class="d-actions">
            <button class="d-btn d-btn-ghost" data-act="close">关闭</button>
            <button class="d-btn d-btn-danger" data-act="delete" ${it.locked ? 'disabled' : ''}>删除</button>
        </div>`);
    sheet.onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') hideSheet();
        if (act === 'delete' && !it.locked) openConfirm([it.id]);
    };
}

async function openConfirm(ids) {
    if (S.tab === 'chars' && S.scanning) {
        toast('还在清点引用，稍等几秒');
        return;
    }
    showSheet('<div class="d-sheet-title">正在清点要删的东西…</div>');
    let plan;
    try { plan = await planFor(S.tab, ids); } catch (e) {
        showSheet(`<div class="d-sheet-title">清点失败</div><div class="d-note">${esc(e.message)}</div><div class="d-actions"><button class="d-btn d-btn-ghost" data-act="close">关闭</button></div>`)
            .onclick = (ev) => { if (ev.target.closest('[data-act]')) hideSheet(); };
        return;
    }
    const backupOn = localStorage.getItem(LS_BACKUP) !== 'off';
    const parts = plan.size > ZIP_PART_LIMIT ? Math.ceil(plan.size / ZIP_PART_LIMIT) : 1;
    const sizeText = plan.size ? `约 ${fmtSize(plan.size)}` : '文件很小';
    const sheet = showSheet(`
        <div class="d-sheet-title">${esc(plan.title)}</div>
        <div class="d-card">
            <div class="d-card-label">会一起删除</div>
            ${plan.gone.map((g) => `<div class="d-line"><span class="d-dot d-dot-del">${ICON.minus}</span><span class="d-line-label">${esc(g.label)}</span><span class="d-line-meta${g.warn ? ' is-warn' : ''}">${esc(g.meta || '')}</span></div>`).join('')}
        </div>
        ${plan.kept.length ? `<div class="d-card">
            <div class="d-card-label">保留</div>
            ${plan.kept.map((k) => `<div class="d-line"><span class="d-dot d-dot-keep">${ICON.lock}</span><span class="d-line-label">${esc(k.label)}<small>${esc(k.reason)}</small></span></div>`).join('')}
        </div>` : ''}
        ${plan.note ? `<div class="d-note">${esc(plan.note)}</div>` : ''}
        <label class="d-switch-row">
            <span><span class="d-switch-title">删除前下载备份</span><span class="d-sub">${sizeText} · 存到这台设备，不占酒馆空间${parts > 1 ? ` · 分 ${parts} 个压缩包` : ''}</span></span>
            <input type="checkbox" role="switch" ${backupOn ? 'checked' : ''}>
        </label>
        <div class="d-actions">
            <button class="d-btn d-btn-ghost" data-act="close">取消</button>
            <button class="d-btn d-btn-danger d-grow" data-act="go">${backupOn ? '备份并删除' : '删除'}</button>
        </div>`);
    const sw = sheet.querySelector('input[type=checkbox]');
    const goBtn = sheet.querySelector('[data-act="go"]');
    sw.onchange = () => {
        localStorage.setItem(LS_BACKUP, sw.checked ? 'on' : 'off');
        goBtn.textContent = sw.checked ? '备份并删除' : '删除';
    };
    sheet.onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') hideSheet();
        if (act === 'go') execute(plan, sw.checked);
    };
}

async function execute(plan, withBackup) {
    S.busy = true;
    const sheet = showSheet('<div class="d-sheet-title">正在处理</div><div class="d-progress"></div>');
    const prog = sheet.querySelector('.d-progress');
    const step = (msg) => { prog.textContent = msg; };
    let fails = [];
    let phase = 'backup';
    try {
        if (withBackup) {
            const bk = new Backup();
            await plan.backup(bk, step);
            step('正在打包下载…');
            await bk.download();
        }
        phase = 'delete';
        await plan.run(step);
        phase = 'verify';
        step('正在核对是否真的删掉了…');
        fails = await plan.verify();
    } catch (e) {
        S.busy = false;
        const where = phase === 'backup' ? '备份没完成，所以什么都没删。' : '删到一半停下了，关掉后列表会重新读取，看看还剩什么。';
        await loadData().catch(() => {});
        showSheet(`<div class="d-sheet-title">出错了</div><div class="d-note">${esc(e.message)}</div><div class="d-note">${where}</div><div class="d-actions"><button class="d-btn d-btn-ghost" data-act="done">关闭</button></div>`)
            .onclick = (ev) => { if (ev.target.closest('[data-act]')) finish(); };
        return;
    }
    S.busy = false;
    const needReload = ['themes', 'presets', 'bgs', 'personas'].includes(S.tab);
    const ok = fails.length === 0;
    const res = showSheet(`
        <div class="d-sheet-title">${ok ? '已经删干净了' : `有 ${fails.length} 项没删掉`}</div>
        ${ok ? '' : `<div class="d-card">${fails.map((f) => `<div class="d-line"><span class="d-dot d-dot-keep">${ICON.lock}</span><span class="d-line-label">${esc(f)}</span></div>`).join('')}</div>`}
        ${needReload ? '<div class="d-note">酒馆里的下拉菜单要刷新页面后才会同步。</div>' : ''}
        <div class="d-actions">
            ${needReload ? '<button class="d-btn d-btn-ghost" data-act="reload">刷新页面</button>' : ''}
            <button class="d-btn d-btn-accent d-grow" data-act="done">完成</button>
        </div>`);
    res.onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'reload') location.reload();
        if (act === 'done') finish();
    };
}

function finish() {
    hideSheet();
    S.select = false;
    S.selected.clear();
    renderAll();
}

/* ---------------- 入口 ---------------- */

jQuery(async () => {
    await loadInternals();

    const menuItem = $(`
        <div id="dusted-menu" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-broom extensionsMenuExtensionButton"></div>
            <span>拂尘</span>
        </div>`);
    menuItem.on('click', openPanel);
    $('#extensionsMenu').append(menuItem);

    const settings = $(`
        <div class="dusted-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>拂尘 · Dusted</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="menu_button" id="dusted-open">打开清理面板</div>
                </div>
            </div>
        </div>`);
    settings.find('#dusted-open').on('click', openPanel);
    $('#extensions_settings2').append(settings);

    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
        if (!localStorage.getItem(LS_MODE)) { applyMode(); renderHeader(); }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && root && !S.busy) {
            if (!$d('.d-sheet-wrap').hidden) hideSheet();
            else closePanel();
        }
    });
});
