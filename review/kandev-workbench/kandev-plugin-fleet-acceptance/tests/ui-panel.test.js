import assert from 'node:assert/strict';
import test from 'node:test';

test('验收面板注册桌面与手机入口；停用和再次启用不残留注册',async()=>{
	let definition;
	globalThis.window={registerKandevPlugin(id,value){assert.equal(id,'kandev-plugin-fleet-acceptance');definition=value;}};
	await import('../ui/bundle.js?fleet-panel-test');
	for(let i=0;i<2;i++){
		const panels=[];
		definition.initialize({registerTaskPanel(panel){panels.push(panel);}}, {React:{},jsx(){},ui:{}});
		assert.equal(panels.length,1);
		assert.equal(panels[0].id,'fleet-acceptance');
		assert.equal(panels[0].mobileEnabled,true);
		assert.equal(typeof panels[0].Component,'function');
		definition.destroy();
	}
});
