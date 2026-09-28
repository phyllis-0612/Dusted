const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const pluginRoot = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(pluginRoot, 'work'), {recursive:true});
const theme = `html body div:not(#chat):not(#sheld) > div[hidden] { display: block !important; opacity: 0 !important; }
html body #dusted-root .d-sheet { position: absolute !important; top: -10000px !important; }`;
// SillyTavern 1.19 sets transform on html and fixes body; html then has zero height.
// Nested fixed overlays use that containing block rather than the viewport.
const tavernLayout = `html { transform: translateZ(0); perspective: 1000px; }
body { position: fixed; margin: 0; width: 100%; height: 100dvh; }`;
const browserOptions = {headless:true};
if (process.env.DUSTED_BROWSER_EXECUTABLE) browserOptions.executablePath = process.env.DUSTED_BROWSER_EXECUTABLE;
async function setup(browser, source, hostile = false, mobile = false, withTavernLayout = true) {
    const page = await browser.newPage({viewport:{width:mobile?390:1000,height:800},hasTouch:mobile,isMobile:mobile});
    const errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    await page.route('http://dusted.test/**', r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>'}));
    await page.goto('http://dusted.test');
    await page.addStyleTag({content:(withTavernLayout?tavernLayout:'')+fs.readFileSync(`${source}/style.css`,'utf8')+(hostile?theme:'')});
    await page.evaluate(() => {
        window.jQuery=()=>{};
        window.calls=[];
        window.data={chars:[{avatar:'test.png',name:'Test card',data:{extensions:{}}}],worlds:['Test world'],avatars:['test.png'],bgs:['test.jpg'],themes:[{name:'Test theme'}],presets:['Test preset']};
        window.pu={personas:{'test.png':'Test persona'},persona_descriptions:{}};
        window.groups=[];
        window.worldEntries={};
        window.SillyTavern={getContext:()=>({characters:data.chars,powerUserSettings:pu,groups:window.groups,extensionSettings:{},saveSettingsDebounced:()=>{},getRequestHeaders:()=>({'Content-Type':'application/json'})})};
        window.fetch=async (url,options={})=>{
            const body=JSON.parse(options.body||'{}');
            calls.push({url,method:options.method,body});
            if(url==='/api/worldinfo/get') {
                if(window.worldDelay) await new Promise(resolve=>setTimeout(resolve,window.worldDelay));
                if(window.failWorld) return {ok:false,status:500};
                return {ok:true,status:200,json:async()=>({entries:window.worldEntries})};
            }
            if(url.endsWith('/delete')) {
                await new Promise(resolve=>setTimeout(resolve,100));
                if(window.failDelete) return {ok:false,status:500};
                if(url.includes('characters')) data.chars=data.chars.filter(c=>c.avatar!==body.avatar_url);
                if(url.includes('worldinfo')) data.worlds=data.worlds.filter(w=>w!==body.name);
                if(url.includes('avatars')) data.avatars=data.avatars.filter(a=>a!==body.avatar);
                if(url.includes('backgrounds')) data.bgs=data.bgs.filter(b=>b!==body.bg);
                if(url.includes('themes')) data.themes=data.themes.filter(t=>t.name!==body.name);
                if(url.includes('presets')) data.presets=data.presets.filter(p=>p!==body.name);
            }
            let value=[];
            if(url.includes('/settings/get')) value={settings:'{}',world_names:data.worlds,themes:data.themes,openai_setting_names:data.presets,openai_settings:data.presets.map(()=>({}))};
            if(url.includes('/avatars/get')) value=data.avatars;
            if(url.includes('/backgrounds/all')) value=data.bgs;
            if(url.includes('/characters/all')) value=data.chars;
            return {ok:true,status:200,headers:new Headers({'content-length':'2'}),json:async()=>value,arrayBuffer:async()=>new Uint8Array([1,2]).buffer};
        };
    });
    await page.addScriptTag({content:fs.readFileSync(`${source}/index.js`,'utf8')+'\nwindow.testDusted={S,internals,openPanel,renderAll,hideSheet,closePanel,execute,openDetail};'});
    await page.evaluate(async()=>{localStorage.setItem('dusted-backup','off');await testDusted.openPanel();testDusted.S.tab='themes';testDusted.renderAll();});
    return {page,errors};
}
async function hitItem(page) {
    return page.locator('.d-item').first().evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));});
}
async function click(page, selector, mobile) {
    if(mobile) await page.locator(selector).tap(); else await page.locator(selector).click();
}
async function assertDetailActionsReachable(page) {
    for(const action of ['close','delete']) {
        const hit=await page.locator(`.d-detail-actions [data-act="${action}"]`).evaluate(el=>{
            const b=el.getBoundingClientRect();
            const sheet=el.closest('.d-sheet').getBoundingClientRect();
            return b.top>=sheet.top && b.bottom<=Math.min(sheet.bottom,innerHeight)
                && el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));
        });
        assert.equal(hit,true,`${action} must remain onscreen and receive clicks without scrolling back`);
    }
}
(async()=>{
    const browser=await chromium.launch(browserOptions);
    try {
        if (process.env.DUSTED_BASELINE) {
        const original=await setup(browser,process.env.DUSTED_BASELINE,true,false,false);
        assert.equal(await hitItem(original.page),false,'Original theme overlay must reproduce blocked item clicks');
        console.log('REPRODUCED: hidden overlay intercepts original item clicks under conflicting theme CSS');
        await original.page.close();
        const oldLayout=await setup(browser,process.env.DUSTED_BASELINE);
        await oldLayout.page.locator('.d-item').click();
        assert.equal(await oldLayout.page.locator('.d-sheet-wrap').evaluate(el=>el.getBoundingClientRect().height),0);
        assert.ok(await oldLayout.page.locator('.d-sheet').evaluate(el=>el.getBoundingClientRect().top<0));
        console.log('REPRODUCED: SillyTavern transformed html collapses original fixed modal to zero height');
        await oldLayout.page.close();
        }
        for(const mobile of [false,true]) {
            const {page,errors}=await setup(browser,pluginRoot,true,mobile);
            assert.equal(await hitItem(page),true);
            await click(page,'.d-item',mobile);
            await page.locator('.d-sheet-title').filter({hasText:'Test theme'}).waitFor();
            assert.equal(await page.locator('.d-sheet-wrap').evaluate(el=>el.getBoundingClientRect().height),800);
            assert.ok(await page.locator('.d-sheet').evaluate(el=>el.getBoundingClientRect().top>=0));
            await click(page,'.d-sheet [data-act="delete"]',mobile);
            await page.locator('.d-sheet [data-act="go"]').waitFor();
            assert.equal(await page.evaluate(()=>calls.filter(c=>c.url.endsWith('/delete')).length),0);
            await click(page,'.d-sheet [data-act="close"]',mobile);
            assert.equal(await hitItem(page),true);
            await click(page,'[data-act="enter-select"]',mobile);
            await click(page,'.d-item',mobile);
            await click(page,'.d-bar [data-act="delete"]',mobile);
            await page.locator('.d-sheet [data-act="go"]').waitFor();
            await click(page,'.d-sheet [data-act="go"]',mobile);
            await page.locator('.d-sheet-title').filter({hasText:'已经删干净了'}).waitFor();
            assert.equal(await page.evaluate(()=>calls.filter(c=>c.url.endsWith('/delete')).length),1);
            await click(page,'.d-sheet [data-act="done"]',mobile);
            assert.equal(await page.locator('.d-item').count(),0);
            assert.match(await page.locator('.d-header .d-sub').innerText(), /主题 0/);
            assert.deepEqual(errors,[]);
            console.log(`PASS: ${mobile?'mobile touch':'desktop'} details, cancel, multiselect, confirmation, delete, verified refresh under theme overrides`);
            await page.close();
        }
        const endpoints={chars:'/api/characters/delete',worlds:'/api/worldinfo/delete',personas:'/api/avatars/delete',bgs:'/api/backgrounds/delete',themes:'/api/themes/delete',presets:'/api/presets/delete'};
        for(const [tab,endpoint] of Object.entries(endpoints)) {
            const {page,errors}=await setup(browser,pluginRoot);
            await page.evaluate(tab=>{testDusted.S.tab=tab;testDusted.renderAll();},tab);
            await page.locator('.d-item').click();
            await page.locator('.d-sheet [data-act="delete"]').click();
            await page.locator('.d-sheet [data-act="go"]').waitFor();
            // Exercise default backup as well as plain deletion.
            if(tab==='themes') await page.locator('.d-sheet input[type="checkbox"]').check();
            await page.locator('.d-sheet [data-act="go"]').click();
            await page.locator('.d-sheet-title').filter({hasText:'已经删干净了'}).waitFor();
            assert.equal(await page.evaluate(endpoint=>calls.filter(c=>c.url===endpoint).length,endpoint),1);
            assert.deepEqual(errors,[]);
            console.log(`PASS: ${tab} deletion request and server-state verification${tab==='themes'?' with backup':''}`);
            await page.close();
        }
        const {page,errors}=await setup(browser,pluginRoot);
        await page.evaluate(()=>{testDusted.S.tab='chars';testDusted.renderAll();testDusted.S.scanning=true;});
        await page.locator('.d-item').click();
        await page.locator('.d-sheet [data-act="delete"]').click();
        assert.equal(await page.locator('.d-toast').isVisible(),true);
        assert.equal(await page.locator('.d-toast').evaluate(el=>getComputedStyle(el).zIndex), '2147483002');
        assert.equal(await page.evaluate(()=>calls.filter(c=>c.url.endsWith('/delete')).length),0);
        await page.screenshot({path:path.join(pluginRoot,'work/scanning-fixed.png')});
        console.log('PASS: scan-in-progress feedback is above the modal and sends no deletion request');
        await page.evaluate(()=>{testDusted.S.scanning=false;testDusted.S.tab='themes';testDusted.hideSheet();testDusted.renderAll();window.failDelete=true;});
        await page.locator('.d-item').click();
        await page.locator('.d-sheet [data-act="delete"]').click();
        await page.locator('.d-sheet [data-act="go"]').click();
        await page.locator('.d-sheet-title').filter({hasText:'有 1 项没删掉'}).waitFor();
        assert.deepEqual(errors,[]);
        console.log('PASS: failed deletion remains in data and is reported as failed');
        await page.close();
        const guard=await setup(browser,pluginRoot);
        const count=await guard.page.evaluate(async()=>{
            let count=0;
            const plan={backup:async()=>{},run:async()=>{count++;await new Promise(r=>setTimeout(r,50));},verify:async()=>[]};
            await Promise.all([testDusted.execute(plan,false),testDusted.execute(plan,false)]);
            return count;
        });
        assert.equal(count,1);
        assert.deepEqual(guard.errors,[]);
        console.log('PASS: repeated confirmation starts only one deletion task');
        await guard.page.close();
        for(const mobile of [false,true]) {
            const preview=await setup(browser,pluginRoot,true,mobile);
            const page=preview.page;
            if(mobile) await page.setViewportSize({width:320,height:568});
            await page.evaluate(()=>{
                pu.default_persona='test.png';
                pu.persona_descriptions['test.png']={title:'旅行者',lorebook:'Test world',description:'<img src=x onerror="window.injected=true">\n'+'人设描述🌸'.repeat(90)+'全文结尾',connections:[
                    {type:'character',id:'test.png'},{type:'character',id:'test.png'},
                    {type:'character',id:'missing.png'},{type:'group',id:'42'},
                ]};
                window.groups=[{id:42,name:'Test group'}];
                testDusted.S.tab='personas';testDusted.renderAll();
            });
            await click(page,'.d-item',mobile);
            await assertDetailActionsReachable(page);
            assert.match(await page.locator('.d-sheet').innerText(),/旅行者/);
            assert.match(await page.locator('.d-sheet').innerText(),/关联角色卡 · 2 张/);
            assert.match(await page.locator('.d-sheet').innerText(),/Test card/);
            assert.match(await page.locator('.d-sheet').innerText(),/找不到对应角色卡/);
            assert.match(await page.locator('.d-sheet').innerText(),/Test group/);
            assert.equal(await page.locator('.d-preview-content img').count(),0);
            assert.ok(Array.from(await page.locator('.d-preview-card .d-preview-content').first().innerText()).length<=81);
            await click(page,'.d-preview-more summary',mobile);
            assert.match(await page.locator('.d-preview-more[open] .d-preview-content').innerText(),/全文结尾$/);
            await page.locator('.d-sheet').evaluate(el=>{el.scrollTop=el.scrollHeight;});
            await assertDetailActionsReachable(page);
            await click(page,'.d-sheet [data-act="close"]',mobile);
            await page.evaluate(()=>{
                pu.persona_descriptions={};testDusted.renderAll();
            });
            await click(page,'.d-item',mobile);
            assert.equal(await page.locator('.d-sheet').evaluate(el=>el.scrollTop),0);
            assert.match(await page.locator('.d-sheet').innerText(),/还没有填写人设描述/);
            assert.match(await page.locator('.d-sheet').innerText(),/没有关联角色卡/);
            await click(page,'.d-sheet [data-act="close"]',mobile);
            await page.evaluate(()=>{
                worldEntries=Object.fromEntries(Array.from({length:8},(_,i)=>[i,{uid:i,displayIndex:7-i,comment:`条目 ${i}`,key:['关键字',String(i)],keysecondary:['次关键词'],content:i===7?'<script>window.injected=true</script>'+ '长内容🌸'.repeat(100)+'世界书全文结尾':`内容 ${i}`,disable:i===6,constant:i===7}]));
                testDusted.S.tab='worlds';testDusted.renderAll();
            });
            await click(page,'.d-item',mobile);
            await page.locator('.d-preview-entry').first().waitFor();
            assert.equal(await page.locator('[data-world-count]').innerText(),'8 条');
            assert.equal(await page.locator('.d-preview-entry').count(),3);
            await assertDetailActionsReachable(page);
            assert.equal(await page.locator('.d-preview-entry .d-preview-title').first().innerText(),'条目 7');
            assert.match(await page.locator('.d-detail-preview').innerText(),/常驻/);
            assert.match(await page.locator('.d-detail-preview').innerText(),/已禁用/);
            assert.match(await page.locator('.d-detail-preview').innerText(),/次关键词/);
            assert.equal(await page.locator('.d-detail-preview script').count(),0);
            await click(page,'.d-preview-more summary',mobile);
            assert.match(await page.locator('.d-preview-more[open] .d-preview-content').innerText(),/世界书全文结尾$/);
            await page.locator('.d-sheet').evaluate(el=>{el.scrollTop=el.scrollHeight;});
            await assertDetailActionsReachable(page);
            // Collapse again, then load the remaining batches.
            await click(page,'.d-preview-more summary',mobile);
            await click(page,'[data-act="preview-more"]',mobile);
            assert.equal(await page.locator('.d-preview-entry').count(),6);
            await click(page,'[data-act="preview-more"]',mobile);
            assert.equal(await page.locator('.d-preview-entry').count(),8);
            assert.equal(await page.locator('[data-act="preview-more"]').count(),0);
            assert.equal(await page.locator('.d-sheet').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
            await page.locator('.d-sheet').evaluate(el=>{el.scrollTop=el.scrollHeight;});
            await assertDetailActionsReachable(page);
            await click(page,'.d-sheet [data-act="delete"]',mobile);
            await page.locator('.d-sheet [data-act="go"]').waitFor();
            assert.equal(await page.locator('.d-detail-preview').count(),0);
            await click(page,'.d-sheet [data-act="close"]',mobile);
            assert.equal(await page.evaluate(()=>window.injected),undefined);
            assert.equal(await page.evaluate(()=>calls.filter(c=>c.url.endsWith('/delete')).length),0);
            assert.deepEqual(preview.errors,[]);
            console.log(`PASS: ${mobile?'small mobile touch':'desktop'} compact previews, sticky actions after long-text expansion and pagination, and confirmation after preview`);
            await page.close();
        }
        const asyncPreview=await setup(browser,pluginRoot);
        await asyncPreview.page.evaluate(()=>{testDusted.S.tab='worlds';testDusted.renderAll();window.failWorld=true;});
        await asyncPreview.page.locator('.d-item').click();
        await asyncPreview.page.locator('[data-act="preview-retry"]').waitFor();
        await asyncPreview.page.evaluate(()=>{window.failWorld=false;});
        await asyncPreview.page.locator('[data-act="preview-retry"]').click();
        await asyncPreview.page.getByText('这本世界书没有条目').waitFor();
        await asyncPreview.page.locator('.d-sheet [data-act="close"]').click();
        await asyncPreview.page.evaluate(()=>{window.worldDelay=200;worldEntries={0:{comment:'迟到的预览',content:'迟到的内容'}};});
        await asyncPreview.page.locator('.d-item').click();
        await asyncPreview.page.locator('.d-sheet [data-act="close"]').click();
        await asyncPreview.page.waitForFunction(()=>testDusted.S.worldLoads.size===0);
        assert.equal(await asyncPreview.page.locator('.d-sheet-wrap').isVisible(),false);
        assert.doesNotMatch(await asyncPreview.page.locator('.d-sheet').textContent(),/迟到的内容/);
        await asyncPreview.page.locator('.d-item').click();
        await asyncPreview.page.locator('.d-sheet [data-act="delete"]').click();
        await asyncPreview.page.locator('.d-sheet [data-act="go"]').waitFor();
        await asyncPreview.page.waitForFunction(()=>testDusted.S.worldLoads.size===0);
        assert.equal(await asyncPreview.page.locator('.d-detail-preview').count(),0);
        assert.equal(await asyncPreview.page.locator('.d-sheet [data-act="go"]').isVisible(),true);
        assert.deepEqual(asyncPreview.errors,[]);
        console.log('PASS: world error retry, empty book and late response after close or switching to confirmation');
        await asyncPreview.page.close();
    } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
