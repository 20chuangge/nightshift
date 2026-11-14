/**
 * textmenu.mjs - which items the right-click menu shows for the clicked spot.
 *
 * Selected text: copy, read aloud, translate, ask the assistant, search.
 * A text box: cut / copy / paste / select all as well. Reading, translating
 * and asking need the page's window.lamplitSelection (a hub page from before
 * 1.2.152 has none, so those are left out there). Kept apart from main.mjs
 * so it can be tested without Electron.
 */

export function textMenuTemplate(params, { hasPageTools = true, zh = true } = {}) {
  const L = (cn, en) => (zh ? cn : en);
  const selected = String(params?.selectionText || '').trim();
  const editable = Boolean(params?.isEditable);
  const flags = params?.editFlags || {};
  const items = [];
  if (editable) items.push({ role: 'cut', label: L('剪切', 'Cut'), enabled: Boolean(flags.canCut) });
  if (selected || editable) items.push({ role: 'copy', label: L('复制', 'Copy'), enabled: Boolean(selected) });
  if (editable) items.push({ role: 'paste', label: L('粘贴', 'Paste'), enabled: flags.canPaste !== false });
  if (selected && hasPageTools) {
    items.push({ type: 'separator' });
    items.push({ id: 'speak', label: L('朗读', 'Read aloud') });
    items.push({ id: 'translate', label: L('翻译', 'Translate') });
    items.push({ id: 'ask', label: L('问助理', 'Ask the assistant') });
  }
  if (selected) items.push({ id: 'search', label: L('用浏览器搜索', 'Search the web') });
  if (editable) {
    items.push({ type: 'separator' });
    items.push({ role: 'selectAll', label: L('全选', 'Select all') });
  }
  return items;
}
