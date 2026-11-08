// Dialogs: fund & model settings, account connection, keyboard help, palette.
import {h, icon, fill} from "./dom.js";
import * as F from "./format.js";
import {dialogFrame, openDialog, openFloating, closeDialog, toast} from "./ui.js";
import {STRATEGIES} from "../lib/strategies.mjs";
import {DEFAULT_SETTINGS, mergeSettings} from "../lib/checks.mjs";

/* ------------------------------------------------------------- settings */
const FIELDS = [
  ["资金（对话 #90 · 交易模型）", [
    ["riskBudget", "期权风险预算", "USDT", 1, "交易模型：期权账户 1,000 USDT，接受全部亏损"],
    ["holdingsUsd", "现货持仓市值", "USDT", 1, "对话 #90：约 6,000 美元现货"],
    ["holdingsBtc", "或现货数量（优先）", "BTC", 1, "填写后按 BTC 数量匹配保护 / 备兑"],
    ["dcaDaily", "每日定投", "USDT", 1, "对话 #90：每天定投 20 美元"],
    ["dipCash", "独立抄底资金", "USDT", 1, "对话 #69、#141：另有现金在低价抄底"],
  ]],
  ["纪律（对话 #99 · #107）", [
    ["maxOpenShortPuts", "同时持有卖 Put 笔数上限", "笔", 1, "对话 #99：初期只允许同时持有一笔"],
    ["maxShortPutQty", "卖 Put 总数量上限", "BTC", 1, "对话 #107：初始总仓位不超过 0.01 BTC"],
    ["payoutCapPct", "最大赔付上限", "% 现货", 1, "对话 #107：未到期 Put 最大赔付 ≤ 现货价值约 10%"],
  ]],
  ["模型与压力", [
    ["evVolCustom", "自定义预测波动率", "%", 100, "预测波动率选「自定义」时使用"],
    ["drift", "年化价格漂移 μ", "%", 100, "0 表示模型期望价格等于当前指数"],
    ["stressIvShift", "强平估算 IV 上升", "点", 100, "急跌时 IV 往往同时上升（对话 #76：负 Vega）"],
    ["stressElapsedDays", "盯市压力经过天数", "天", 1, "与原卖 Put 工作台一致，默认 1 天"],
  ]],
  ["币安手续费（基础费率）", [
    ["fees.tradeRate", "交易费率", "%", 100, "min(0.024% × 指数, 10% × 权利金)"],
    ["fees.exerciseRate", "行权费率", "%", 100, "min(0.015% × 结算价, 10% × 内在价值)"],
    ["fees.cap", "费用封顶比例", "%", 100, "按权利金或内在价值的比例封顶"],
  ]],
];

const read = (settings, path) => path.split(".").reduce((value, key) => value?.[key], settings);

export function openSettings(dialog, state, actions) {
  const inputs = new Map();
  const field = ([key, label, unit, scale, hint]) => {
    const value = read(state.settings, key);
    const input = h("input.text-input", {type: "number", step: "any", inputmode: "decimal", "aria-label": label,
      value: value === null || value === undefined ? "" : Number((value * scale).toPrecision(10))});
    inputs.set(key, {input, scale});
    return h("label", {}, h("span", {}, label, h("span.muted", {text: " · " + unit})), input, h("small", {text: hint}));
  };
  const vol = h("select.select", {"aria-label": "预测波动率"}, [["rv30", "30 日已实现波动率（默认）"], ["rv7", "7 日已实现波动率"], ["atm", "到期日平值 IV"], ["custom", "自定义"]]
    .map(([value, label]) => h("option", {value, selected: state.settings.evVol === value ? true : null, text: label})));
  const enforce = h("input", {type: "checkbox", checked: state.settings.enforceDiscipline ? true : null});
  const body = [
    ...FIELDS.map(([legend, fields]) => h("fieldset", {}, h("legend", {text: legend}), h("div.form-grid", {}, fields.map(field),
      legend.startsWith("纪律") ? h("label.switch", {}, enforce, h("span", {}, "严格执行纪律", h("small", {text: "开启后，违反纪律的候选直接排除；关闭时仅标注警告"}))) : null,
      legend.startsWith("模型") ? h("label", {}, h("span", {text: "预测波动率（模型期望与 ES）"}), vol, h("small", {text: "胜率始终使用市场隐含 IV"})) : null))),
  ];
  const collect = () => {
    const next = structuredClone(state.settings);
    for (const [key, {input, scale}] of inputs) {
      const raw = input.value.trim();
      const value = raw === "" ? null : Number(raw) / scale;
      if (key.startsWith("fees.")) next.fees[key.slice(5)] = value ?? DEFAULT_SETTINGS.fees[key.slice(5)];
      else next[key] = value ?? (key === "holdingsBtc" ? null : DEFAULT_SETTINGS[key]);
    }
    next.evVol = vol.value;
    next.enforceDiscipline = enforce.checked;
    return mergeSettings(next);
  };
  fill(dialog, ...dialogFrame("我的资金与模型", "这些数字决定仓位、纪律检查与模型统计；保存在本浏览器", body, [
    h("button.btn.ghost", {type: "button", onClick: () => { actions.saveSettings(mergeSettings({})); closeDialog(dialog); toast("ok", "已恢复默认设置"); }}, icon("reset"), "恢复默认"),
    h("button.btn", {type: "button", onClick: () => closeDialog(dialog)}, "取消"),
    h("button.btn.primary", {type: "button", onClick: () => { actions.saveSettings(collect()); closeDialog(dialog); toast("ok", "设置已保存", "所有策略已按新设置重新计算"); }}, "保存"),
  ]));
  openDialog(dialog);
}

/* -------------------------------------------------------------- account */
export function openAccount(dialog, state, actions) {
  const a = state.account;
  const body = [];
  if (a.data) {
    const usdt = a.data.assets?.find(asset => asset.asset === "USDT") ?? a.data.assets?.[0];
    const p = state.portfolio;
    body.push(h("div.callout.safe", {}, h("strong", {text: a.mode === "server" ? "已通过服务器密钥连接（只读）" : "已在浏览器内连接（只读，密钥仅在内存）"}),
      `读取于 ${F.beijing(a.data.receivedAt, {date: true})}（北京）。本看板没有任何下单、撤单或划转接口。`));
    body.push(h("div.account-grid", {},
      [["账户权益", usdt?.equity], ["可用余额", usdt?.available], ["未实现盈亏", usdt?.unrealizedPNL], ["初始保证金", usdt?.initialMargin],
        ["维持保证金", usdt?.maintMargin], ["保证金余额", usdt?.marginBalance]].map(([label, value]) =>
        h("div.stat", {}, h("label", {text: label}), h("strong", {class: label === "未实现盈亏" ? F.tone(Number(value)) : "", text: F.num(Number(value), 2)})))));
    if (p) {
      body.push(h("div.section-title", {text: "组合风险（按到期日精确合并）"}),
        h("dl.kv", {},
          h("dt", {text: "未到期卖 Put"}), h("dd", {text: `${p.openShortPuts} 笔 · ${F.num(p.openShortPutQty, 2)} BTC`}),
          h("dt", {text: "持仓到期最大亏损"}), h("dd", {text: p.openLossUnbounded ? "无上限（含裸卖 Call）" : F.num(p.openMaxLoss, 2) + " USDT"}),
          h("dt", {text: "剩余风险预算"}), h("dd", {text: F.num(p.budgetRemaining, 2) + " / " + F.num(state.settings.riskBudget, 0) + " USDT"}),
          h("dt", {text: "Put 最大赔付 / 上限"}), h("dd", {text: `${F.num(p.payoutTotal, 0)} / ${F.num(p.payoutCap, 0)} USDT`})));
    }
    body.push(h("div.section-title", {text: "当前持仓"}),
      a.data.positions?.length ? h("table.mini", {}, h("thead", {}, h("tr", {}, ["合约", "方向", "数量", "开仓均价", "标记价", "未实现盈亏"].map(text => h("th", {text})))),
        h("tbody", {}, a.data.positions.map(row => h("tr", {}, h("td", {text: row.symbol}), h("td", {class: row.side === "SHORT" ? "neg" : "pos", text: row.side === "SHORT" ? "空" : "多"}),
          h("td", {text: row.quantity}), h("td", {text: F.num(Number(row.entryPrice), 1)}), h("td", {text: F.num(Number(row.markPrice), 1)}),
          h("td", {class: F.tone(Number(row.unrealizedPNL)), text: F.signed(Number(row.unrealizedPNL), 2)})))))
        : h("p.muted", {text: "没有非零期权持仓。"}));
  } else {
    body.push(h("div.callout.note", {}, h("strong", {text: "公开行情不需要 API Key"}),
      "策略筛选、风险分析在未连接账户时即可使用。连接只读账户后，看板会把你的现有持仓计入风险预算、卖 Put 笔数和赔付上限，并检查可用保证金。"));
    const serverInfo = a.server;
    body.push(h("div.mode-cards", {},
      h("button.mode-card", {type: "button", "aria-pressed": String(state.accountTab !== "browser"), onClick: () => actions.setAccountTab("server")},
        h("strong", {text: "服务器密钥（推荐自用部署）"}), h("p", {text: "把只读 Key 写入服务器环境变量，Secret 只在服务器签名，刷新页面也保持连接。"})),
      h("button.mode-card", {type: "button", "aria-pressed": String(state.accountTab === "browser"), onClick: () => actions.setAccountTab("browser")},
        h("strong", {text: "浏览器临时连接"}), h("p", {text: "在本页输入 Key 与 Secret，Secret 转为不可导出的签名密钥只存在内存，关闭页面即失效。"}))));
    if (state.accountTab !== "browser") {
      const status = serverInfo === undefined ? "正在检查服务器配置…" : !serverInfo ? "无法连接策略服务。"
        : !serverInfo.configured ? (serverInfo.reason === "invalid_format" ? "服务器已设置密钥，但格式不是币安的 64 位 Key / Secret。" : "服务器尚未配置 API Key（这是预期状态，等你填写）。")
          : serverInfo.reason === "hosted_requires_token" ? "服务器已配置 Key，但公网部署未设置访问令牌，已拒绝返回账户数据（默认拒绝）。"
            : serverInfo.reason === "token_required" ? "服务器已配置 Key，请输入访问令牌。" : serverInfo.error ? "币安返回错误：" + serverInfo.error : "已配置。";
      body.push(h("p", {text: status}));
      body.push(h("div.section-title", {text: "本机运行（options_site/local_bridge.mjs）"}),
        h("pre.code", {text: "# 在仓库根目录创建 .env（已被 git 忽略）\nBINANCE_API_KEY=你的64位只读Key\nBINANCE_API_SECRET=你的64位Secret\n\nnode options_site/build.mjs\nnode options_site/local_bridge.mjs\n# 打开 http://127.0.0.1:8767/strategy"}),
        h("div.section-title", {text: "公网部署（Render）"}),
        h("pre.code", {text: "# Render → btcoptions → Environment（Secret）\nBINANCE_API_KEY=…\nBINANCE_API_SECRET=…\nBTCOPT_ACCESS_TOKEN=至少24位随机字符串\n# 在下方输入同一个访问令牌即可读取"}));
      const token = h("input.text-input", {type: "password", autocomplete: "off", placeholder: "访问令牌（仅公网部署需要）", "aria-label": "访问令牌", value: state.accountToken ?? ""});
      body.push(h("div.form-col", {}, h("label", {}, "访问令牌", token, h("small", {text: "保存在当前标签页的会话存储中，关闭标签页即清除。"}))),
        h("div", {style: {display: "flex", gap: "8px"}},
          h("button.btn.primary", {type: "button", onClick: () => actions.connectServer(token.value.trim() || null)}, "连接服务器账户"),
          h("button.btn", {type: "button", onClick: () => actions.checkServer()}, icon("reset"), "重新检查")));
    } else {
      const key = h("input.text-input", {type: "password", autocomplete: "off", spellcheck: "false", "aria-label": "API Key", placeholder: "64 位 API Key"});
      const secret = h("input.text-input", {type: "password", autocomplete: "off", spellcheck: "false", "aria-label": "Secret", placeholder: "64 位 Secret"});
      body.push(h("div.form-grid", {}, h("label", {}, "API Key", key), h("label", {}, "Secret", secret)),
        h("p.muted", {text: "Secret 在本页导入为不可导出的 HMAC 密钥后立即清空输入框；请求只发送 API Key 与几秒内有效的签名，经网站转发给币安。请只开启「读取」权限并绑定 IP 白名单。"}),
        h("div", {}, h("button.btn.primary", {type: "button", onClick: async () => {
          const k = key.value.trim(), s = secret.value.trim();
          key.value = ""; secret.value = "";
          await actions.connectBrowser(k, s);
        }}, "在浏览器内连接")));
    }
    if (a.error) body.push(h("div.callout.danger", {}, h("strong", {text: "连接失败"}), a.error));
  }
  const footer = a.data ? [
    h("button.btn", {type: "button", onClick: () => actions.refreshAccount()}, icon("reset"), "刷新"),
    h("button.btn", {type: "button", onClick: () => { actions.disconnectAccount(); }}, "断开"),
    h("button.btn.primary", {type: "button", onClick: () => closeDialog(dialog)}, "完成"),
  ] : [h("button.btn", {type: "button", onClick: () => closeDialog(dialog)}, "关闭")];
  fill(dialog, ...dialogFrame("币安期权账户", "只读：持仓、保证金与风险预算占用", body, footer));
  openDialog(dialog);
}

/* ----------------------------------------------------------------- help */
export function openHelp(dialog) {
  const keys = [["命令面板", ["Ctrl", "K"]], ["切换策略 1–8", ["1", "…", "8"]], ["上一 / 下一个策略", ["[", "]"]], ["选择候选", ["↑", "↓"]],
    ["打开详情", ["Enter"]], ["冻结 / 恢复实时", ["F"]], ["导出 CSV", ["E"]], ["切换主题", ["T"]], ["资金与模型设置", ["S"]], ["账户", ["A"]],
    ["关闭弹层", ["Esc"]], ["快捷键", ["?"]]];
  const body = [
    h("div.shortcuts", {}, keys.map(([label, combo]) => h("div", {}, label, h("span", {}, combo.map(k => h("kbd", {text: k})))))),
    h("div.section-title", {text: "数据与口径"}),
    h("ul.notes", {},
      h("li", {text: "行情来自币安期权公开接口：卖出按买一价、买入按卖一价计算，已扣币安基础手续费。"}),
      h("li", {text: "到期损益为精确的现金结算公式（含行权费）；胜率用市场隐含 IV，期望收益与 ES 用预测波动率，均为对数正态模型值。"}),
      h("li", {text: "急跌触发使用币安 BTCUSDT 小时 K 线：窗口内最高价到当前指数的回撤。"}),
      h("li", {text: "参数旁的彩色圆点表示来源：朱色为你的规则，蓝色为对话建议，紫色为工作台设置，灰色为默认。"}),
      h("li", {text: "看板只读，没有任何下单接口；所有结果仅供研究，不构成投资建议。"})),
  ];
  fill(dialog, ...dialogFrame("快捷键与说明", "像交易终端一样，用键盘完成大部分操作", body, [h("button.btn.primary", {type: "button", onClick: () => closeDialog(dialog)}, "知道了")]));
  openDialog(dialog);
}

/* -------------------------------------------------------------- palette */
function score(text, query) {
  const hay = text.toLowerCase(), needle = query.toLowerCase();
  if (!needle) return 1;
  const index = hay.indexOf(needle);
  if (index >= 0) return 100 - index;
  let pos = 0;
  for (const ch of needle) { pos = hay.indexOf(ch, pos); if (pos < 0) return 0; pos++; }
  return 10;
}

function highlight(text, query) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index < 0) return text;
  return [text.slice(0, index), h("mark", {text: text.slice(index, index + query.length)}), text.slice(index + query.length)];
}

export function openPalette(dialog, state, actions) {
  const input = h("input", {type: "text", placeholder: "输入策略、行权价（如 64000）或操作…", "aria-label": "命令", autocomplete: "off", spellcheck: "false"});
  const list = h("div.palette-list", {role: "listbox"});
  let items = [], active = 0;
  const commands = [
    {group: "操作", label: "导出当前结果为 CSV", hint: "E", icon: "download", run: actions.exportCsv},
    {group: "操作", label: "复制当前策略链接", hint: "", icon: "link", run: actions.copyLink},
    {group: "操作", label: state.frozen ? "恢复实时行情" : "冻结当前快照", hint: "F", icon: state.frozen ? "play" : "pause", run: actions.toggleFreeze},
    {group: "操作", label: "我的资金与模型设置", hint: "S", icon: "gear", run: actions.openSettings},
    {group: "操作", label: "币安账户（只读）", hint: "A", icon: "wallet", run: actions.openAccount},
    {group: "操作", label: "切换明暗主题", hint: "T", icon: "sun", run: actions.toggleTheme},
    {group: "操作", label: state.alerts ? "关闭急跌提醒" : "开启急跌提醒", hint: "", icon: "bell", run: actions.toggleAlerts},
    {group: "操作", label: "重置当前策略参数", hint: "", icon: "reset", run: actions.resetParams},
    {group: "操作", label: "打开期权链", hint: "", icon: "chain", run: () => { location.href = "./"; }},
    {group: "操作", label: "快捷键与说明", hint: "?", icon: "keyboard", run: actions.openHelp},
    ...(actions.canUseLocal() ? [{group: "操作", label: actions.usingLocal() ? "切回网站线路" : "改用本机连接器（127.0.0.1:8767）", hint: "", icon: "layers", run: actions.toggleLocal}] : []),
  ];
  const render = () => {
    const query = input.value.trim();
    const strategies = STRATEGIES.map(s => ({group: "策略", label: s.name, sub: s.nameEn, hint: s.hotkey ?? "", glyph: s.id,
      score: Math.max(score(s.name, query), score(s.nameEn, query), score(s.tagline, query) * .5), run: () => actions.selectStrategy(s.id)}));
    const contracts = query.length >= 2 ? (state.result?.candidates ?? []).filter(c => c.legs.some(leg => leg.symbol.includes(query.toUpperCase()) || String(leg.strike).startsWith(query)))
      .slice(0, 8).map(c => ({group: "当前候选", label: c.legs.map(leg => (leg.action === "SELL" ? "卖 " : "买 ") + leg.symbol).join(" + "), sub: "净权利金 " + F.signed(c.metrics.netCredit, 2),
        score: 50, run: () => actions.selectCandidate(c.key, {open: true})})) : [];
    const actionsList = commands.map(command => ({...command, score: score(command.label, query)}));
    items = [...strategies, ...contracts, ...actionsList].filter(item => item.score > 0).sort((a, b) => query ? b.score - a.score : 0);
    if (!query) items = [...strategies, ...actionsList];
    active = Math.min(active, Math.max(0, items.length - 1));
    let lastGroup = null;
    fill(list, ...items.flatMap((item, index) => {
      const nodes = [];
      if (item.group !== lastGroup) { nodes.push(h("div.palette-group", {text: item.group})); lastGroup = item.group; }
      nodes.push(h("button.palette-item", {type: "button", role: "option", id: "pal" + index, "aria-selected": String(index === active),
        onClick: () => { closeDialog(dialog); item.run(); }, onPointermove: () => { if (active !== index) { active = index; paint(); } }},
      item.icon ? icon(item.icon) : h("span", {}),
      h("span", {}, highlight(item.label, query), item.sub ? h("small", {text: "  " + item.sub}) : null),
      item.hint ? h("kbd", {text: item.hint}) : h("span")));
      return nodes;
    }));
    if (!items.length) list.append(h("div.palette-group", {text: "没有匹配项"}));
    input.setAttribute("aria-activedescendant", "pal" + active);
  };
  const paint = () => {
    list.querySelectorAll(".palette-item").forEach((node, index) => node.setAttribute("aria-selected", String(index === active)));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({block: "nearest"});
    input.setAttribute("aria-activedescendant", "pal" + active);
  };
  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") { event.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); active = Math.max(0, active - 1); paint(); }
    else if (event.key === "Enter") { event.preventDefault(); const item = items[active]; if (item) { closeDialog(dialog); item.run(); } }
  });
  fill(dialog, h("div.palette-input", {}, icon("search"), input, h("kbd", {text: "Esc"})), list,
    h("div.palette-foot", {}, h("span", {}, h("kbd", {text: "↑"}), h("kbd", {text: "↓"}), " 选择"), h("span", {}, h("kbd", {text: "Enter"}), " 执行"), h("span", {}, h("kbd", {text: "Esc"}), " 关闭")));
  // The field answers the shortcut in this frame; the list fills the next.
  openFloating(dialog);
  input.focus();
  requestAnimationFrame(() => { if (dialog.open && !list.firstChild) render(); });
}
