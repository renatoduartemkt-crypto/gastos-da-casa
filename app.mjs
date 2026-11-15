import { CATEGORIAS, CAT, SUGESTOES, definirCategorias } from './categorias.mjs';

const CFG = window.GASTOS_CONFIG || {};

const $ = s => document.querySelector(s);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round(n * 100) / 100;
const parseBR = v => { v = String(v ?? '').trim().replace(/[R$\s]/g, ''); if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.'); const n = parseFloat(v); return isFinite(n) ? n : NaN; };
const hoje = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const mesAtual = () => hoje().slice(0, 7);
const somaMes = (mes, d) => { const [y, m] = mes.split('-').map(Number); const t = new Date(y, m - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
const nomeMes = mes => { const [y, m] = mes.split('-').map(Number); const t = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1); };
const fmtDia = d => new Date(d + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
const tag = (v, cls = '') => { const [i, c] = r2(v).toFixed(2).split('.'); return `<span class="tag ${cls}"><small>R$</small>${Number(i).toLocaleString('pt-BR')},<small>${c}</small></span>`; };
const titulo = s => String(s || '').toLowerCase().replace(/\b(ltda|me|epp|eireli|s\/?a)\b\.?/g, '').replace(/\s+/g, ' ').trim()
  .replace(/(^|\s)(\S+)/g, (m, sp, w, i) => sp + (i > 0 && /^(de|da|do|das|dos|e)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)));

/* ---------- estado ---------- */
const lerLocal = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const gravarLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const S = {
  auth: lerLocal('gastos:auth', null),
  mes: mesAtual(), view: 'resumo', voltarPara: 'resumo',
  meses: {},          // cache: mes -> lista de gastos
  filtro: null,       // categoria escolhida na lista
  nota: null,         // gasto aberto na tela de nota (novo ou existente)
  manualCat: null,
  resumos: {},        // cache: mes -> { gastos, receitas, anterior }
  receitas: {},       // cache: mes -> lista de receitas
  painel: {},         // cache: mes -> dados do painel
  cartoes: [], tiposReceita: [], pagamentos: ['Pix', 'Cartão de Crédito', 'Cartão de Débito', 'Dinheiro', 'Boleto', 'Débito automático', 'Vale-alimentação', 'Transferência'],
  iniciado: false,
};
// Qualquer gravação de gasto ou receita pode mexer em vários meses (parcelas, fixos): a tela busca de novo.
function limparCaches() { S.meses = {}; S.resumos = {}; S.receitas = {}; S.painel = {}; }

/* ---------- API ---------- */
// S.auth = { token, usuario: { uid, nome, admin } }; a versão antiga guardava a senha da casa e é descartada.
if (S.auth && !S.auth.token) { S.auth = null; gravarLocal('gastos:auth', null); }
const meuNome = () => S.auth?.usuario?.nome || '';

// O backend é um Apps Script: todo pedido vai num POST de texto simples (sem pré-checagem de CORS)
// com { path, method, query, body, token }; a resposta vem como { status, body }.
async function api(path, opts = {}) {
  if (!CFG.backendUrl) throw new Error('O app ainda não está ligado ao backend (config.js).');
  const [p, qs] = path.split('?');
  const method = (opts.method || 'GET').toUpperCase();
  const corpo = JSON.stringify({ path: p, method, query: Object.fromEntries(new URLSearchParams(qs || '')), body: opts.body ?? null, token: S.auth?.token || null });
  const uma = async () => {
    let r;
    try { r = await fetch(CFG.backendUrl, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: corpo, redirect: 'follow' }); }
    catch { throw Object.assign(new Error('Sem conexão. Verifique a internet e tente de novo.'), { passageira: true }); }
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok || !j || typeof j.status !== 'number') throw Object.assign(new Error('O servidor não respondeu direito. Tente de novo.'), { passageira: true });
    return j;
  };
  let j;
  try { j = await uma(); }
  catch (e) { if (!e.passageira || method !== 'GET') throw e; await new Promise(r => setTimeout(r, 1200)); j = await uma(); }
  const b = j.body || {};
  if (j.status === 401 && S.auth && !opts.semSair) { sair(b.erro); throw new Error(b.erro || 'Entre de novo.'); }
  if (j.status >= 400) throw new Error(b.erro || 'Não foi possível concluir. Tente de novo.');
  return b;
}
async function carregarMes(mes, forcar) {
  if (S.meses[mes] && !forcar) return S.meses[mes];
  const { gastos } = await api('gastos?mes=' + mes);
  S.meses[mes] = gastos;
  return gastos;
}
async function carregarResumo(mes) {
  if (S.resumos[mes]) return S.resumos[mes];
  const r = await api('mes?mes=' + mes);
  S.resumos[mes] = r; S.meses[mes] = r.gastos; S.receitas[mes] = r.receitas;
  if (!S.meses[r.anterior.mes]) S.meses[r.anterior.mes] = r.anterior.gastos;
  return r;
}
async function carregarReceitas(mes) {
  if (S.receitas[mes]) return S.receitas[mes];
  const { receitas } = await api('receitas?mes=' + mes);
  return (S.receitas[mes] = receitas);
}
// Dados que valem para o app todo: categorias, cartões, tipos de receita.
async function carregarInicio() {
  const r = await api('inicio');
  definirCategorias(r.categorias); S.cartoes = r.cartoes || []; S.tiposReceita = r.tiposReceita || []; if (r.pagamentos?.length) S.pagamentos = r.pagamentos;
  if (S.auth) { S.auth.usuario = r.usuario; gravarLocal('gastos:auth', S.auth); }
  S.iniciado = true;
  return r;
}

/* ---------- utilidades de gastos ---------- */
// Divide o valor pago entre as categorias dos itens, repartindo o desconto da nota proporcionalmente.
function porCategoria(g) {
  const out = {};
  if (g.itens?.length) {
    const soma = g.itens.reduce((s, i) => s + i.vt, 0);
    const f = soma > 0 ? g.total / soma : 1;
    for (const i of g.itens) out[i.cat] = (out[i.cat] || 0) + i.vt * f;
  } else out[g.cat || 'outros'] = g.total;
  return out;
}
const catDot = id => `<span class="dot" style="background:${CAT[id]?.cor || '#888'}"></span>`;
const nomeCat = id => CAT[id]?.nome || 'Outros';

let toastT;
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 3600); }
function carregando(msg) { $('#carregando').hidden = !msg; if (msg) $('#car-msg').textContent = msg; }

/* ---------- navegação ---------- */
const VIEWS = ['entrar', 'resumo', 'painel', 'mercado', 'lancar', 'gastos', 'receitas', 'nota', 'conta', 'ajustes', 'fixo'];
const ABAS = ['resumo', 'painel', 'lancar', 'gastos', 'receitas', 'mercado'];
const COM_HASH = [...ABAS, 'conta', 'ajustes'];
function ir(v) {
  if (!CFG.backendUrl) { $('#sem-backend').hidden = false; for (const id of VIEWS) $('#v-' + id).hidden = true; return; }
  if (!S.auth) { v = 'entrar'; prepararEntrar(); }
  if (v !== 'nota' && v !== 'fixo') S.voltarPara = v;
  S.view = v;
  for (const id of VIEWS) $('#v-' + id).hidden = id !== v;
  $('#tabs').hidden = v === 'entrar';
  document.querySelectorAll('.tabs button').forEach(b => b.dataset.v === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  $('#quem-btn').hidden = !S.auth; if (S.auth) $('#quem-btn').textContent = meuNome();
  $('#ajustes-btn').hidden = !S.auth;
  if (v !== 'mercado') { $('#mk-barra').hidden = true; document.body.classList.remove('com-barra'); }
  if (COM_HASH.includes(v)) try { history.replaceState(null, '', '#' + v); } catch {}
  window.scrollTo(0, 0);
  render();
}
async function render() {
  if (S.auth && !S.iniciado && S.view !== 'entrar') {
    try { await carregarInicio(); } catch (e) { toast(e.message); return; }
  }
  if (S.view === 'resumo') return renderResumo();
  if (S.view === 'painel') return renderPainel();
  if (S.view === 'gastos') return renderGastos();
  if (S.view === 'lancar') return renderLancar();
  if (S.view === 'receitas') return renderReceitas();
  if (S.view === 'nota') return renderNota();
  if (S.view === 'conta') return renderConta();
  if (S.view === 'ajustes') return renderAjustes();
  if (S.view === 'fixo') return renderFixo();
  if (S.view === 'mercado') return renderMercado();
}

/* ---------- aparência (por celular) ---------- */
const CORES = [['#1D5BB8', '#7DAEFF', 'Azul'], ['#1B7F47', '#53C487', 'Verde'], ['#6B3FA0', '#B996F0', 'Roxo'], ['#C0512B', '#FF9A6B', 'Laranja'], ['#B8336A', '#FF8FBF', 'Rosa'], ['#2F3B47', '#B9C6D2', 'Grafite']];
const pref = { cor: lerLocal('gastos:cor', CORES[0][0]), abas: lerLocal('gastos:abas', ABAS), inicio: lerLocal('gastos:inicio', 'resumo') };
function aplicarAparencia() {
  const c = CORES.find(x => x[0] === pref.cor) || CORES[0];
  const escuro = matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.style.setProperty('--accent', escuro ? c[1] : c[0]);
  const ordem = [...pref.abas.filter(a => ABAS.includes(a)), ...ABAS.filter(a => !pref.abas.includes(a))];
  ordem.forEach((a, i) => { const b = document.querySelector(`.tabs [data-tab="${a}"]`); if (b) b.style.order = i; });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', aplicarAparencia);
aplicarAparencia();

function sair(msg) {
  S.auth = null; limparCaches(); S.iniciado = false; gravarLocal('gastos:auth', null);
  ir('entrar');
  if (msg) { $('#e-erro').textContent = msg; $('#e-erro').hidden = false; }
}

/* ---------- entrar ---------- */
// Modos: 'criar' (primeira conta), 'migrar' (havia só a senha da casa), 'entrar', 'convite'.
let modoEntrada = 'entrar', modoBase = 'entrar';
async function prepararEntrar(modo) {
  if (!modo) {
    try { const e = await api('estado', { semSair: true }); modoBase = !e.temUsuarios ? (e.senhaAntiga ? 'migrar' : 'criar') : 'entrar'; }
    catch { modoBase = 'entrar'; }
    modo = modoBase;
  }
  modoEntrada = modo;
  const T = {
    criar: ['Criar sua conta', 'Primeiro acesso: escolha seu nome e uma senha (mínimo 6 caracteres). Depois você convida sua esposa pela tela da sua conta.', 'Criar conta e entrar'],
    migrar: ['Entrar', 'O app agora tem uma conta para cada pessoa. Digite seu nome e a senha da casa que você criou: ela passa a ser a sua senha pessoal.', 'Entrar'],
    entrar: ['Entrar', 'Digite seu nome e sua senha. Você continua conectado neste celular.', 'Entrar'],
    convite: ['Aceitar convite', 'Digite o código que você recebeu e escolha a sua senha (mínimo 6 caracteres).', 'Criar minha senha e entrar'],
  }[modo];
  $('#e-titulo').textContent = T[0]; $('#e-texto').textContent = T[1]; $('#e-botao').textContent = T[2];
  const nova = modo === 'criar' || modo === 'convite';
  $('#e-codigo-wrap').hidden = modo !== 'convite';
  $('#e-nome-wrap').hidden = modo === 'convite';
  $('#e-conf-wrap').hidden = !nova;
  $('#e-senha-rot').textContent = modo === 'migrar' ? 'Senha da casa' : nova ? 'Escolha uma senha' : 'Senha';
  $('#e-senha').autocomplete = nova ? 'new-password' : 'current-password';
  $('#e-troca').hidden = modo === 'criar';
  $('#e-troca').textContent = modo === 'convite' ? 'Já tenho conta' : 'Recebi um convite';
  $('#e-troca').dataset.act = modo === 'convite' ? 'modo-entrar' : 'modo-convite';
}
$('#f-entrar').addEventListener('submit', async e => {
  e.preventDefault();
  const falhar = msg => { $('#e-erro').textContent = msg; $('#e-erro').hidden = false; };
  $('#e-erro').hidden = true;
  const nome = $('#e-nome').value.trim(), senha = $('#e-senha').value, codigo = $('#e-codigo').value.trim();
  const nova = modoEntrada === 'criar' || modoEntrada === 'convite';
  if (modoEntrada === 'convite' && !codigo) return falhar('Digite o código do convite.');
  if (modoEntrada !== 'convite' && nome.length < 2) return falhar('Digite seu nome.');
  if (!senha) return falhar('Digite a senha.');
  if (nova && senha.length < 6) return falhar('A senha precisa ter pelo menos 6 caracteres.');
  if (nova && senha !== $('#e-conf').value) return falhar('As duas senhas não são iguais.');
  const rota = { criar: 'criar-conta', migrar: 'entrar', entrar: 'entrar', convite: 'aceitar-convite' }[modoEntrada];
  const btn = $('#e-botao'); btn.disabled = true;
  try {
    const r = await api(rota, { method: 'POST', body: modoEntrada === 'convite' ? { codigo, senha } : { nome, senha }, semSair: true });
    S.auth = { token: r.token, usuario: r.usuario };
    gravarLocal('gastos:auth', S.auth);
    $('#e-senha').value = ''; $('#e-conf').value = ''; $('#e-codigo').value = '';
    if (modoEntrada === 'convite') toast(`Boas-vindas, ${r.usuario.nome}!`);
    if (modoEntrada === 'criar') toast('Conta criada! Se você tem o backup do app antigo, importe em Conta.');
    S.iniciado = false; limparCaches();
    ir(pref.inicio || 'resumo');
  } catch (err) {
    falhar(err.message);
    if (/já foi criada|Ainda não há contas/.test(err.message)) prepararEntrar();
  } finally { btn.disabled = false; }
});

/* ---------- conta ---------- */
async function renderConta() {
  const u = S.auth.usuario;
  $('#c-ola').textContent = `Olá, ${u.nome}`;
  $('#f-convite').hidden = !u.admin;
  $('#c-importar').hidden = !u.admin;
  try {
    const { usuarios } = await api('usuarios');
    if (S.view !== 'conta') return;
    $('#c-pessoas').innerHTML = usuarios.map(p => `<div class="fixo-row"><div class="body"><div class="name">${esc(p.nome)}${p.uid === u.uid ? ' <span class="muted small">(você)</span>' : ''}</div><div class="meta small muted">${p.admin ? 'Criou a casa' : 'Membro'}</div></div>
      ${u.admin && p.uid !== u.uid ? `<button class="btn ghost danger" data-act="remover" data-uid="${p.uid}" data-confirm="Remover ${esc(p.nome)}?">Remover</button>` : ''}</div>`).join('');
  } catch (e) { $('#c-pessoas').innerHTML = `<p class="erro">${esc(e.message)}</p>`; }
}
$('#c-arquivo').addEventListener('change', async e => {
  const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
  const msg = $('#c-import-msg');
  let dados;
  try { dados = JSON.parse(await f.text()); } catch { msg.textContent = 'Esse arquivo não é um backup válido (.json).'; return; }
  carregando('Importando os dados do app antigo…');
  try {
    const r = await api('importar', { method: 'POST', body: { dados } });
    limparCaches();
    msg.innerHTML = `<strong>Pronto!</strong> ${r.importados} registros importados${r.ignorados ? ` (${r.ignorados} itens de login antigos foram ignorados de propósito)` : ''}.`;
    toast('Dados importados.');
  } catch (err) { msg.textContent = err.message; } finally { carregando(null); }
});
$('#f-convite').addEventListener('submit', async e => {
  e.preventDefault();
  const nome = $('#c-nome').value.trim(); if (!nome) return;
  try {
    const c = await api('convites', { method: 'POST', body: { nome } });
    const link = location.href.split('#')[0];
    $('#c-convite').innerHTML = `<div>Convite para <strong>${esc(c.nome)}</strong>. Vale até ${new Date(c.expira).toLocaleDateString('pt-BR')} e só pode ser usado uma vez.</div>
      <div style="margin:10px 0"><span class="codigo" id="c-codigo">${esc(c.codigo)}</span></div>
      <div class="small">Mande para ela: abrir <strong>${esc(link)}</strong>, tocar em <strong>“Recebi um convite”</strong> e digitar o código. Ela mesma escolhe a senha.</div>
      <div class="actions" style="margin-top:10px"><button class="btn" data-act="copiar-convite" data-texto="${esc(`Oi ${c.nome}! Entre em ${link} , toque em "Recebi um convite" e use o código ${c.codigo} para criar sua senha no Gastos da Casa.`)}">Copiar mensagem</button></div>`;
    $('#c-convite').hidden = false; $('#c-nome').value = '';
  } catch (err) { toast(err.message); }
});
$('#f-senha').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('senha', { method: 'POST', body: { atual: $('#s-atual').value, nova: $('#s-nova').value }, semSair: true });
    $('#s-atual').value = ''; $('#s-nova').value = ''; toast('Senha trocada.');
  } catch (err) { toast(err.message); }
});

/* ---------- gráficos simples (SVG) ---------- */
// Rosca: partes [{ v, cor, nome }]
function rosca(partes, centro, sub) {
  const total = partes.reduce((s, p) => s + p.v, 0) || 1, R = 52, C = 2 * Math.PI * R;
  let acc = 0;
  const arcos = partes.map(p => { const l = p.v / total * C, a = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.cor}" stroke-width="22" stroke-dasharray="${Math.max(0, l - 1.2).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 70 70)"><title>${esc(p.nome)}: ${brl.format(p.v)}</title></circle>`; acc += l; return a; }).join('');
  return `<svg viewBox="0 0 140 140" class="rosca" role="img" aria-label="Gastos por categoria"><circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--sunk)" stroke-width="22"/>${arcos}
    <text x="70" y="68" text-anchor="middle" class="rosca-v">${esc(centro)}</text><text x="70" y="86" text-anchor="middle" class="rosca-s">${esc(sub || '')}</text></svg>`;
}
const n2 = v => (+v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mesCurto = m => nomeMes(m).slice(0, 3).toLowerCase() + '/' + m.slice(2, 4);
const pct = (v, base) => base > 0 ? Math.round(v / base * 100) : 0;
const curto = v => v >= 1000 ? 'R$ ' + (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: v >= 10000 ? 0 : 1 }) + ' mil' : brl.format(v);
const nomeCartao = id => S.cartoes.find(c => c.id === id)?.nome || null;
const somaG = l => l.reduce((s, g) => s + g.total, 0);
// "renato" e "Renato" são a mesma pessoa: agrupa sem acento/maiúscula e mostra a grafia mais bonita
const chaveP = n => String(n || 'Sem nome').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function porPessoa(lista, campo) {
  const o = {}, rot = {};
  for (const x of lista) { const k = chaveP(x.quem); o[k] = (o[k] || 0) + (x[campo] || 0); const n = String(x.quem || 'Sem nome').trim(); if (!rot[k] || (/^[a-z]/.test(rot[k]) && /^[A-ZÀ-Ú]/.test(n))) rot[k] = n; }
  return Object.entries(o).map(([k, v]) => [rot[k], v]);
}
function juntarPessoas(obj) { const o = {}, rot = {}; for (const [n, v] of Object.entries(obj)) { const k = chaveP(n); o[k] = (o[k] || 0) + v; if (!rot[k] || /^[a-z]/.test(rot[k])) rot[k] = n; } return Object.fromEntries(Object.entries(o).map(([k, v]) => [rot[k], v])); }
const somaR = l => l.reduce((s, r) => s + r.valor, 0);
function catsDe(lista) { const o = {}; for (const g of lista) for (const [c, v] of Object.entries(porCategoria(g))) o[c] = (o[c] || 0) + v; return o; }
function deltaPill(v, ant) {
  if (!(ant > 0)) return v > 0 ? '<span class="pill">novo</span>' : '';
  const d = Math.round((v - ant) / ant * 100);
  return d === 0 ? '<span class="pill">=</span>' : `<span class="pill ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}%</span>`;
}

/* ---------- resumo ---------- */
async function renderResumo() {
  const mes = S.mes;
  $('#r-mes').textContent = nomeMes(mes);
  if (!S.resumos[mes]) { $('#r-total').innerHTML = '<div class="spinner"></div>'; $('#r-comp').textContent = 'Carregando…'; for (const id of ['#r-cats', '#r-pessoas', '#r-ultimos', '#r-kpis', '#r-donut', '#r-tipo', '#r-pag', '#r-orc']) $(id).innerHTML = ''; }
  let R;
  try { R = await carregarResumo(mes); } catch (e) { $('#r-total').innerHTML = `<p class="erro">${esc(e.message)}</p>`; $('#r-comp').textContent = ''; return; }
  if (S.view !== 'resumo' || S.mes !== mes) return;
  const lista = R.gastos, anterior = R.anterior.gastos, receitas = R.receitas;
  const total = somaG(lista), rec = somaR(receitas), saldo = rec - total;
  const previstos = lista.filter(g => g.previsto).length;
  $('#r-total').innerHTML = tag(total, 'xl');

  // comparação com o mês anterior (até o mesmo dia, quando o mês é o atual)
  if (anterior.length) {
    let base = somaG(anterior), rotulo = `em ${nomeMes(R.anterior.mes).split(' ')[0]}`;
    if (mes === mesAtual()) { const dia = hoje().slice(8); base = anterior.filter(g => g.data.slice(8) <= dia).reduce((s, g) => s + g.total, 0); rotulo = `até o dia ${Number(dia)} do mês passado`; }
    const d = base > 0 ? (total - base) / base : 0;
    $('#r-comp').innerHTML = base > 0 ? `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${Math.round(d * 100)}%</span> em relação a ${brl.format(base)} ${rotulo}` : '';
  } else $('#r-comp').textContent = lista.length ? `${lista.length} ${lista.length === 1 ? 'lançamento' : 'lançamentos'}` : '';
  if (previstos) $('#r-comp').innerHTML += `<br><span class="small">Inclui ${previstos} ${previstos === 1 ? 'gasto fixo previsto' : 'gastos fixos previstos'} para este mês.</span>`;

  const diasMes = new Date(+mes.slice(0, 4), +mes.slice(5, 7), 0).getDate();
  const diasCorridos = mes === mesAtual() ? Number(hoje().slice(8)) : mes < mesAtual() ? diasMes : 0;
  $('#r-kpis').innerHTML = [
    ['Receitas', rec > 0 ? brl.format(rec) : '—', 'ir', 'receitas'],
    ['Saldo', rec > 0 ? brl.format(saldo) : '—', saldo < 0 ? 'neg' : 'pos'],
    ['Média por dia', diasCorridos ? brl.format(total / diasCorridos) : '—'],
    ['Comprometido', rec > 0 ? pct(total, rec) + '% da receita' : '—'],
  ].map(([k, v, cls, ir]) => `<${ir ? `button data-act="ir" data-v="${ir}"` : 'div'} class="kpi ${cls && cls !== 'ir' ? cls : ''}"><span>${k}</span><strong>${v}</strong></${ir ? 'button' : 'div'}>`).join('');

  const cats = catsDe(lista), catsAnt = catsDe(anterior);
  const ord = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const max = ord[0]?.[1] || 1;

  // orçamento por categoria
  const comOrc = CATEGORIAS.filter(c => c.orcamento > 0);
  $('#r-orc-card').hidden = !comOrc.length;
  if (comOrc.length) {
    const orcTotal = comOrc.reduce((s, c) => s + c.orcamento, 0), gastoOrc = comOrc.reduce((s, c) => s + (cats[c.id] || 0), 0);
    $('#r-orc-sum').textContent = `${brl.format(gastoOrc)} de ${brl.format(orcTotal)}`;
    $('#r-orc').innerHTML = `<div class="bars">${comOrc.map(c => {
      const v = cats[c.id] || 0, p = v / c.orcamento, cls = p > 1 ? 'estourou' : p > .8 ? 'quase' : 'ok';
      return `<button class="bar orc ${cls}" data-act="filtrar" data-cat="${c.id}"><span class="nm">${catDot(c.id)}${esc(c.nome)}</span>
        <span class="vl">${brl.format(v)}<small>de ${brl.format(c.orcamento)}</small></span>
        <span class="tr"><i style="width:${Math.min(100, p * 100).toFixed(1)}%"></i></span>
        <span class="orc-msg small">${p > 1 ? `Passou ${brl.format(v - c.orcamento)} do orçamento` : `Restam ${brl.format(c.orcamento - v)}`}</span></button>`;
    }).join('')}</div>`;
  }

  // rosca + barras por categoria
  const top = ord.slice(0, 7), resto = ord.slice(7).reduce((s, [, v]) => s + v, 0);
  const partes = top.map(([c, v]) => ({ v, cor: CAT[c]?.cor || '#888', nome: nomeCat(c) }));
  if (resto > 0) partes.push({ v: resto, cor: '#B5BEC6', nome: 'Demais categorias' });
  $('#r-donut').innerHTML = ord.length ? rosca(partes, curto(total), `${ord.length} ${ord.length === 1 ? 'categoria' : 'categorias'}`) : '';
  $('#r-cats').innerHTML = ord.length ? ord.map(([c, v]) => `
    <button class="bar" data-act="filtrar" data-cat="${c}">
      <span class="nm">${catDot(c)}${esc(nomeCat(c))} ${anterior.length ? deltaPill(v, catsAnt[c] || 0) : ''}</span><span class="vl">${brl.format(v)}<small>${pct(v, total)}%</small></span>
      <span class="tr"><i style="width:${(v / max * 100).toFixed(1)}%;background:${CAT[c]?.cor}"></i></span>
    </button>`).join('')
    : `<div class="empty"><strong>Nenhum gasto em ${esc(nomeMes(mes))}</strong><span>Toque em Lançar e leia o QR code de uma nota, ou registre um gasto à mão.</span></div>`;

  // fixos, parcelas e variáveis
  const fixos = somaG(lista.filter(g => g.origem === 'fixo')), parc = somaG(lista.filter(g => g.parcela)), varia = total - fixos - parc;
  const tipos = [['Gastos fixos', fixos, '#3F6E8C'], ['Parcelas do cartão', parc, '#8E44AD'], ['Gastos do dia a dia', varia, '#E0662B']].filter(x => x[1] > 0.004);
  $('#r-tipo-card').hidden = !tipos.length;
  $('#r-tipo').innerHTML = tipos.map(([n, v, cor]) => `<div class="bar" style="cursor:default"><span class="nm"><span class="dot" style="background:${cor}"></span>${n}</span><span class="vl">${brl.format(v)}<small>${pct(v, total)}%</small></span><span class="tr"><i style="width:${pct(v, total)}%;background:${cor}"></i></span></div>`).join('');

  // como foi pago
  const pags = {};
  for (const g of lista) { const k = (g.pagamento || 'Não informado') + (nomeCartao(g.cartao) ? ' · ' + nomeCartao(g.cartao) : ''); pags[k] = (pags[k] || 0) + g.total; }
  const pOrd = Object.entries(pags).sort((a, b) => b[1] - a[1]);
  $('#r-pag-card').hidden = !pOrd.length;
  $('#r-pag').innerHTML = pOrd.map(([p, v]) => `<div class="bar" style="cursor:default"><span class="nm">${esc(p)}</span><span class="vl">${brl.format(v)}<small>${pct(v, total)}%</small></span><span class="tr"><i style="width:${(v / pOrd[0][1] * 100).toFixed(1)}%;background:var(--accent)"></i></span></div>`).join('');

  const qOrd = porPessoa(lista, 'total').sort((a, b) => b[1] - a[1]);
  $('#r-pessoas-card').hidden = !qOrd.length;
  $('#r-pessoas').innerHTML = qOrd.map(([p, v]) => `<div class="bar" style="cursor:default"><span class="nm">${esc(p)}</span><span class="vl">${brl.format(v)}<small>${pct(v, total)}%</small></span><span class="tr"><i style="width:${(v / qOrd[0][1] * 100).toFixed(1)}%;background:var(--accent)"></i></span></div>`).join('');

  $('#r-ultimos').innerHTML = lista.length ? `<div class="list">${lista.slice(0, 5).map(g => linhaGasto(g)).join('')}</div>` : '<p class="muted small" style="margin:0">Nada lançado ainda neste mês.</p>';
  atualizarQuem(lista);
}
function linhaGasto(g, valor) {
  const cats = Object.keys(porCategoria(g));
  const meta = [fmtDia(g.data), g.quem, g.itens?.length ? `${g.itens.length} itens` : nomeCat(g.cat), nomeCartao(g.cartao)].filter(Boolean).join(' · ');
  const selos = (g.origem === 'nfce' ? '<span class="badge-nf">NF</span>' : '') + (g.parcela ? `<span class="badge-nf parc">${g.parcela.n}/${g.parcela.de}</span>` : '') +
    (g.origem === 'fixo' ? '<span class="badge-nf">FIXO</span>' : '') + (g.previsto ? '<span class="badge-nf prev">PREVISTO</span>' : '');
  return `<button class="row${g.previsto ? ' previsto' : ''}" data-act="abrir" data-key="${esc(g.key)}">
    <span style="display:flex;gap:3px">${cats.slice(0, 3).map(catDot).join('')}</span>
    <span class="body"><span class="name">${esc(g.descricao)}${selos}</span><br><span class="meta">${esc(meta)}</span></span>
    <span class="val">${brl.format(valor ?? g.total)}</span></button>`;
}
function atualizarQuem(lista) {
  const nomes = new Set([meuNome(), ...Object.values(S.meses).flat().map(g => g.quem)].filter(Boolean));
  $('#dl-quem').innerHTML = [...nomes].map(n => `<option value="${esc(n)}">`).join('');
}

/* ---------- lista de gastos ---------- */
async function renderGastos() {
  const mes = S.mes;
  $('#g-mes').textContent = nomeMes(mes);
  $('#g-lista').innerHTML = '<div class="empty"><div class="spinner"></div></div>';
  let lista;
  try { lista = await carregarMes(mes); } catch (e) { $('#g-lista').innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }
  if (S.view !== 'gastos' || S.mes !== mes) return;
  const presentes = new Set(lista.flatMap(g => Object.keys(porCategoria(g))));
  $('#g-filtro').innerHTML = `<button class="chip" data-act="filtrar" data-cat="" aria-pressed="${!S.filtro}">Todas</button>` +
    CATEGORIAS.filter(c => presentes.has(c.id)).map(c => `<button class="chip" data-act="filtrar" data-cat="${c.id}" aria-pressed="${S.filtro === c.id}">${catDot(c.id)}${esc(c.nome)}</button>`).join('');
  const linhas = lista.map(g => ({ g, v: S.filtro ? porCategoria(g)[S.filtro] : g.total })).filter(x => x.v > 0);
  if (!linhas.length) { $('#g-lista').innerHTML = `<div class="card"><div class="empty"><strong>Nada por aqui</strong><span>${S.filtro ? 'Nenhum gasto nessa categoria neste mês.' : 'Nenhum gasto lançado neste mês.'}</span></div></div>`; return; }
  const total = linhas.reduce((s, x) => s + x.v, 0);
  let html = `<div class="sum"><span class="muted small">${linhas.length} ${linhas.length === 1 ? 'lançamento' : 'lançamentos'}${S.filtro ? ' em ' + esc(nomeCat(S.filtro)) : ''}</span>${tag(total, 'lg')}</div>`;
  let dia = '';
  html += '<div class="card" style="padding-block:4px">';
  for (const { g, v } of linhas) {
    if (g.data !== dia) { if (dia) html += '</div>'; dia = g.data; html += `<div class="day">${esc(fmtDia(dia))}</div><div class="list">`; }
    html += linhaGasto(g, v);
  }
  html += '</div></div>';
  $('#g-lista').innerHTML = html;
}

/* ---------- pagamento, cartão e parcelas (lançamento manual "m", nota "n", mercado "mk") ---------- */
const ehCredito = p => /cr[eé]dito/i.test(p || '');
const ehCartao = p => /cart[aã]o/i.test(p || '');
function montarPagamento(px, v = {}) {
  const sel = $(`#${px}-pag`);
  const opts = [...S.pagamentos]; if (v.pagamento && !opts.includes(v.pagamento)) opts.push(v.pagamento);
  sel.innerHTML = opts.map(p => `<option>${esc(p)}</option>`).join('');
  if (v.pagamento) sel.value = v.pagamento;
  const doDono = S.cartoes.find(c => c.dono && c.dono.toLowerCase() === meuNome().toLowerCase());
  $(`#${px}-cartao`).innerHTML = '<option value="">Não informar</option>' + S.cartoes.map(c => `<option value="${c.id}">${esc(c.nome)}${c.final ? ' · final ' + esc(c.final) : ''}</option>`).join('');
  $(`#${px}-cartao`).value = v.cartao || (v.pagamento === undefined && doDono ? doDono.id : '') || '';
  $(`#${px}-parc`).innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}">${i ? `${i + 1}x` : 'À vista (1x)'}</option>`).join('');
  $(`#${px}-parc`).value = String(v.parcelas || 1);
  atualizarPagamento(px);
}
function lerPagamento(px) {
  const pagamento = $(`#${px}-pag`).value;
  return { pagamento, cartao: ehCartao(pagamento) ? ($(`#${px}-cartao`).value || null) : null, parcelas: ehCredito(pagamento) ? Number($(`#${px}-parc`).value) || 1 : 1 };
}
// valor e data da compra de cada formulário, para mostrar a prévia das parcelas
function compraDoForm(px) {
  if (px === 'm') return { total: parseBR($('#m-valor').value), data: $('#m-data').value || hoje() };
  if (px === 'n' && S.nota) return { total: S.nota.g.parcela ? S.nota.g.parcela.totalCompra : S.nota.g.total, data: S.nota.g.data || hoje() };
  if (px === 'mk' && S.mk?.compra) return { total: S.mk.compra.itens.reduce((s, i) => s + i.preco * i.qtd, 0), data: hoje() };
  return { total: NaN, data: hoje() };
}
function atualizarPagamento(px) {
  const { pagamento, cartao, parcelas } = lerPagamento(px);
  $(`#${px}-cartao-wrap`).hidden = !ehCartao(pagamento) || !S.cartoes.length;
  $(`#${px}-parc-wrap`).hidden = !ehCredito(pagamento);
  const info = $(`#${px}-parc-info`);
  const { total, data } = compraDoForm(px);
  if (parcelas < 2) { info.hidden = true; return; }
  const c = S.cartoes.find(x => x.id === cartao);
  let mes1 = data.slice(0, 7);
  const pulou = c?.fechamento && Number(data.slice(8, 10)) >= c.fechamento;
  if (pulou) mes1 = somaMes(mes1, 1);
  const mesN = somaMes(mes1, parcelas - 1), curtoMes = m => nomeMes(m).replace(/ de /, '/').toLowerCase();
  const valor = total > 0 ? Math.floor(total * 100 / parcelas) / 100 : null;
  info.innerHTML = `<strong>${parcelas}x${valor ? ' de ' + brl.format(valor) : ''}</strong>, de ${esc(curtoMes(mes1))} a ${esc(curtoMes(mesN))}. Cada parcela entra nos gastos do seu mês.` +
    (pulou ? `<br>A compra foi depois do fechamento do ${esc(c.nome)} (dia ${c.fechamento}), então a 1ª parcela cai no mês seguinte.` : '');
  info.hidden = false;
}
document.addEventListener('change', e => {
  const el = e.target.closest('[data-pagto]'); if (!el) return;
  const px = el.dataset.pagto; atualizarPagamento(px);
  if (px === 'n' && S.nota) { Object.assign(S.nota.g, lerPagamento('n')); marcarMudou(); }
});
for (const id of ['#m-valor', '#m-data']) $(id).addEventListener('input', () => atualizarPagamento('m'));

/* ---------- lançar ---------- */
function renderLancar() {
  if (!$('#m-data').value) $('#m-data').value = hoje();
  if (!$('#m-quem').value) $('#m-quem').value = meuNome();
  if (!$('#m-pag').options.length) montarPagamento('m');
  $('#m-cats').innerHTML = CATEGORIAS.map(c => `<button type="button" class="chip" data-act="mcat" data-cat="${c.id}" aria-pressed="${S.manualCat === c.id}">${catDot(c.id)}${esc(c.nome)}</button>`).join('');
  const sug = SUGESTOES[S.manualCat] || [];
  $('#m-sug-wrap').hidden = !sug.length;
  $('#m-sug').innerHTML = sug.map(([d, fixo]) => `<button type="button" class="chip" data-act="msug" data-desc="${esc(d)}" data-fixo="${fixo ? 1 : ''}">${esc(d)}</button>`).join('');
}
$('#f-manual').addEventListener('submit', async e => {
  e.preventDefault();
  const total = parseBR($('#m-valor').value);
  if (!(total > 0)) { toast('Informe o valor, por exemplo 89,90.'); return $('#m-valor').focus(); }
  if (!S.manualCat) { toast('Escolha uma categoria.'); return; }
  const btn = e.submitter; btn.disabled = true;
  const pg = lerPagamento('m'), fixo = $('#m-repetir').checked;
  if (fixo && pg.parcelas > 1) { btn.disabled = false; toast('Gasto fixo não pode ser parcelado. Escolha "À vista" ou desmarque "Repetir todo mês".'); return; }
  try {
    const { gasto } = await api('gastos', { method: 'POST', body: { total, data: $('#m-data').value, descricao: $('#m-desc').value.trim(), cat: S.manualCat, quem: $('#m-quem').value.trim() || meuNome(), ...pg, origem: 'manual', repetir: fixo } });
    adicionarAoCache(gasto);
    $('#m-valor').value = ''; $('#m-desc').value = ''; $('#m-repetir').checked = false; S.manualCat = null; $('#m-parc').value = '1'; atualizarPagamento('m');
    toast(fixo ? `Gasto fixo de ${brl.format(gasto.total)} salvo. Ele será lançado todo mês.`
      : pg.parcelas > 1 ? `Compra de ${brl.format(total)} em ${pg.parcelas}x salva nos próximos meses.` : `Gasto de ${brl.format(gasto.total)} salvo.`);
    S.mes = gasto.data.slice(0, 7); ir('resumo');
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});
// Uma gravação pode mexer em vários meses (parcelas, fixos): limpa o que estava guardado e a tela busca de novo.
function adicionarAoCache() { limparCaches(); }

/* ---------- QR code ---------- */
let stream = null, lendo = false;
async function abrirScanner() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('Este navegador não abre a câmera. Use "Foto do QR code".'); return; }
  $('#scanner').hidden = false; $('#sc-msg').textContent = 'Aponte para o QR code no rodapé da nota';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    fecharScanner();
    toast(e?.name === 'NotAllowedError' ? 'Permita o acesso à câmera nas configurações do navegador, ou use "Foto do QR code".' : 'Não consegui abrir a câmera. Use "Foto do QR code".');
    return;
  }
  const video = $('#sc-video'); video.srcObject = stream; await video.play().catch(() => {});
  let detector = null;
  try { if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch {}
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  lendo = true;
  const passo = async () => {
    if (!lendo) return;
    try {
      let texto = null;
      if (video.readyState >= 2) {
        if (detector) { const r = await detector.detect(video); texto = r[0]?.rawValue || null; }
        else if (window.jsQR) {
          const lado = Math.min(video.videoWidth, video.videoHeight), escala = Math.min(1, 720 / lado);
          canvas.width = canvas.height = Math.round(lado * escala);
          ctx.drawImage(video, (video.videoWidth - lado) / 2, (video.videoHeight - lado) / 2, lado, lado, 0, 0, canvas.width, canvas.height);
          texto = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data || null;
        }
      }
      if (texto) { navigator.vibrate?.(60); fecharScanner(); return processarQr(texto); }
    } catch {}
    setTimeout(passo, 140);
  };
  passo();
}
function fecharScanner() {
  lendo = false;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  $('#sc-video').srcObject = null; $('#scanner').hidden = true;
}
async function lerQrDaFoto(file) {
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    for (const alvo of [1600, 1000, 700]) {
      const s = Math.min(1, alvo / Math.max(bmp.width, bmp.height));
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const r = window.jsQR?.(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
      if (r?.data) return processarQr(r.data);
    }
    toast('Não encontrei o QR code na foto. Tire outra mais de perto, com o QR inteiro e nítido.');
  } catch { toast('Não consegui abrir essa foto.'); }
}
async function processarQr(texto) {
  if (!/^https?:\/\/[^/]+\.gov\.br\//i.test(texto.trim())) { toast('Esse QR code não é de uma nota fiscal (NFC-e).'); return; }
  carregando('Buscando a nota na SEFAZ…');
  try {
    const r = await api('nfce', { method: 'POST', body: { url: texto.trim() } });
    if (r.duplicada) {
      toast('Essa nota já foi lançada. Abrindo o lançamento.');
      const { gasto } = await api('gasto?key=' + encodeURIComponent(r.chave));
      return abrirNota(gasto, false);
    }
    const n = r.nota, data = n.data || hoje();
    // compra do mesmo dia feita pelo app de mercado: a nota é a versão confirmada dela
    const doMes = await carregarMes(data.slice(0, 7)).catch(() => []);
    const par = doMes.find(g => g.origem === 'mercado' && g.data === data);
    abrirNota({ ...n, descricao: titulo(n.loja) || 'Compra', quem: par?.quem || meuNome(), origem: 'nfce', data, substitui: par ? { key: par.key, total: par.total, descricao: par.descricao } : null }, true);
  } catch (e) { toast(e.message); } finally { carregando(null); }
}

/* ---------- nota (revisão e detalhe) ---------- */
// A NFC-e escreve a forma de pagamento do seu jeito ("03 - Cartão de Crédito", "PIX"): traduz para a lista do app.
function pagamentoDaNota(p) {
  const t = String(p || '');
  if (/cr[eé]dito/i.test(t)) return 'Cartão de Crédito';
  if (/d[eé]bito/i.test(t)) return 'Cartão de Débito';
  if (/pix/i.test(t)) return 'Pix';
  if (/dinheiro/i.test(t)) return 'Dinheiro';
  if (/vale|alimenta|refei/i.test(t)) return 'Vale-alimentação';
  return t || 'Pix';
}
function abrirNota(g, nova) {
  g = structuredClone(g);
  // uma parcela abre como a compra inteira: valor total, data da compra e número de parcelas
  if (g.parcela) Object.assign(g, { total: g.parcela.totalCompra, data: g.dataCompra || g.data, parcelas: g.parcela.de });
  if (nova) g.pagamento = pagamentoDaNota(g.pagamento);
  S.nota = { g, nova, mudou: nova, abertos: new Set() };
  ir('nota');
}
function renderNota() {
  const { g, nova } = S.nota;
  $('#n-loja').textContent = g.descricao;
  $('#n-meta').textContent = [g.loja && titulo(g.loja) !== g.descricao ? titulo(g.loja) : null, g.pagamento, nomeCartao(g.cartao), g.itens?.length ? `${g.itens.length} itens` : null].filter(Boolean).join(' · ');
  $('#n-total').innerHTML = tag(g.total, 'lg');
  montarPagamento('n', { pagamento: g.pagamento || 'Pix', cartao: g.cartao, parcelas: g.parcelas || 1 });
  $('#n-pag-card').hidden = !!g.previsto;
  if (g.fixoId) { $('#n-parc-wrap').hidden = true; $('#n-parc').value = '1'; }
  const aviso = [];
  if (g.previsto) aviso.push('Este gasto fixo ainda vai ser lançado: ele aparece aqui como previsão. Para mudar valor ou dia, use Ajustes › Fixos.');
  if (g.parcela) aviso.push(`Parcela <strong>${g.parcela.n} de ${g.parcela.de}</strong> (${brl.format(g.parcela.valor)} por mês) de uma compra de ${brl.format(g.parcela.totalCompra)} feita em ${new Date((g.dataCompra || g.data) + 'T12:00').toLocaleDateString('pt-BR')}. O que você mudar aqui vale para todas as parcelas; apagar remove a compra inteira.`);
  if (nova) aviso.push('Confira as categorias. Itens com <strong>?</strong> foram classificados por aproximação; ao trocar, o app aprende para as próximas notas.');
  if (g.desconto > 0) aviso.push(`Desconto de ${brl.format(g.desconto)} na nota, repartido entre as categorias.`);
  if (nova && g.substitui) {
    const d = g.total - g.substitui.total;
    aviso.push(`<label class="check-row" style="margin-top:6px"><input type="checkbox" id="n-subst" checked><span><strong>Trocar a compra do app de mercado por esta nota</strong><small>“${esc(g.substitui.descricao)}” de ${brl.format(g.substitui.total)} sai e entram os valores da nota (${d >= 0 ? '+' : ''}${brl.format(d)}). Assim o gasto não conta duas vezes.</small></span></label>`);
  }
  $('#n-aviso').innerHTML = aviso.join('<br>'); $('#n-aviso').hidden = !aviso.length;
  $('#n-quem').value = g.quem || ''; $('#n-data').value = g.data || ''; $('#n-desc').value = g.descricao || '';
  const temItens = !!g.itens?.length;
  $('#n-cat-wrap').hidden = temItens; $('#n-resumo-card').hidden = !temItens;
  $('#n-valor-wrap').hidden = temItens; if (!temItens) $('#n-valor').value = r2(g.total).toFixed(2).replace('.', ',');
  $('#n-fixo').hidden = !g.fixoId;
  if (g.fixoId) $('#n-fixo').innerHTML = `Gasto fixo: lançado automaticamente todo mês. Mudar aqui altera só este mês; para mudar valor, dia ou categoria de todos os meses, use <button type="button" class="btn ghost" data-act="ir-fixos">Ajustes › Fixos</button>. <button type="button" class="btn ghost danger" data-act="parar-fixo" data-fid="${esc(g.fixoId)}" data-confirm="Toque de novo para parar">Parar de repetir</button>`;
  if (!temItens) $('#n-cats').innerHTML = CATEGORIAS.map(c => `<button type="button" class="chip" data-act="ncat" data-cat="${c.id}" aria-pressed="${g.cat === c.id}">${catDot(c.id)}${esc(c.nome)}</button>`).join('');
  $('#n-apagar').hidden = nova || !!g.previsto;
  $('#n-apagar').dataset.confirm = g.parcela ? `Toque de novo: apaga as ${g.parcela.de} parcelas` : 'Toque de novo para apagar';
  $('#n-salvar').textContent = nova ? 'Salvar gasto' : 'Salvar alterações';
  $('#n-salvar').hidden = (!nova && !S.nota.mudou) || !!g.previsto;
  for (const id of ['#n-quem', '#n-data', '#n-desc', '#n-valor']) $(id).disabled = !!g.previsto;
  $('label[for="n-valor"]').textContent = g.parcela || (g.parcelas > 1) ? 'Valor total da compra (R$)' : 'Valor (R$)';
  renderItens();
}
function renderItens() {
  const { g } = S.nota;
  if (!g.itens?.length) { $('#n-itens').innerHTML = ''; return; }
  const cats = porCategoria(g), ord = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  $('#n-resumo').innerHTML = ord.map(([c, v]) => `<div class="bar" style="cursor:default"><span class="nm">${catDot(c)}${esc(nomeCat(c))}</span><span class="vl">${brl.format(v)}</span><span class="tr"><i style="width:${(v / ord[0][1] * 100).toFixed(1)}%;background:${CAT[c]?.cor}"></i></span></div>`).join('');
  const opts = sel => CATEGORIAS.map(c => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.nome)}</option>`).join('');
  $('#n-itens').innerHTML = ord.map(([c]) => {
    const itens = g.itens.map((it, idx) => ({ it, idx })).filter(x => x.it.cat === c);
    const bruto = itens.reduce((s, x) => s + x.it.vt, 0);
    // grupos começam fechados, menos os que têm item classificado por aproximação ou o que acabou de mudar
    const aberto = S.nota.abertos.has(c) || itens.some(x => x.it.fonte === 'padrao');
    return `<details class="grupo" data-cat="${c}"${aberto ? ' open' : ''}><summary><span class="t">${catDot(c)}${esc(nomeCat(c))}</span><span class="small muted">${itens.length} ${itens.length === 1 ? 'item' : 'itens'} · ${brl.format(bruto)}</span></summary>
      ${itens.map(({ it, idx }) => `<div class="item${it.fonte === 'padrao' ? ' incerto' : ''}">
        <span class="d">${esc(it.d)}</span><span class="v">${brl.format(it.vt)}</span>
        <span class="q">${num.format(it.q)} ${esc(it.un)}${it.vu != null && it.q !== 1 ? ' × ' + brl.format(it.vu) : ''}</span><span></span>
        <select data-idx="${idx}" aria-label="Categoria de ${esc(it.d)}">${opts(it.cat)}</select></div>`).join('')}
    </details>`;
  }).join('');
}
$('#n-itens').addEventListener('change', e => {
  const sel = e.target.closest('select[data-idx]'); if (!sel) return;
  const it = S.nota.g.itens[+sel.dataset.idx];
  // muda também os outros itens iguais da mesma nota
  for (const x of S.nota.g.itens) if ((it.cod && x.cod === it.cod) || x.d === it.d) { x.cat = sel.value; x.fonte = 'manual'; }
  S.nota.abertos.add(sel.value);
  marcarMudou(); renderItens();
  toast(`Movido para ${nomeCat(sel.value)}.`);
});
for (const id of ['#n-quem', '#n-data', '#n-desc', '#n-valor']) $(id).addEventListener('input', () => {
  const g = S.nota.g; g.quem = $('#n-quem').value.trim(); g.data = $('#n-data').value; g.descricao = $('#n-desc').value.trim() || g.descricao;
  if (!g.itens?.length) { const v = parseBR($('#n-valor').value); if (v > 0) { g.total = r2(v); $('#n-total').innerHTML = tag(g.total, 'lg'); } }
  marcarMudou();
});
function marcarMudou() { S.nota.mudou = true; $('#n-salvar').hidden = false; }
async function salvarNota(btn) {
  const { g, nova } = S.nota;
  btn.disabled = true;
  try {
    const pg = lerPagamento('n'); if (g.fixoId) pg.parcelas = 1;
    const corpo = { data: g.data, hora: g.hora, descricao: g.descricao, loja: g.loja, quem: g.quem || meuNome(), ...pg, total: g.total, bruto: g.bruto, desconto: g.desconto, cat: g.cat, itens: g.itens?.map(({ fonte, ...i }) => i) || null, origem: g.origem, chave: g.chave };
    const subst = nova && g.substitui && $('#n-subst')?.checked ? g.substitui.key : null;
    if (subst) corpo.substitui = subst;
    const { gasto } = nova ? await api('gastos', { method: 'POST', body: corpo }) : await api(`gastos/${g.key.split('/')[1]}/${g.key.split('/')[2]}`, { method: 'PUT', body: corpo });
    adicionarAoCache(gasto);
    toast(pg.parcelas > 1 ? `Compra de ${brl.format(g.total)} em ${pg.parcelas}x salva: cada parcela no seu mês.` : nova ? `Nota de ${brl.format(gasto.total)} lançada.` : 'Alterações salvas.');
    S.mes = gasto.data.slice(0, 7); S.nota = null; ir(nova ? 'resumo' : S.voltarPara);
  } catch (e) { toast(e.message); } finally { btn.disabled = false; }
}
async function apagarNota() {
  const { g } = S.nota;
  try {
    const r = await api(`gastos/${g.key.split('/')[1]}/${g.key.split('/')[2]}`, { method: 'DELETE' });
    limparCaches();
    toast(r.removidos?.length > 1 ? `Compra apagada (${r.removidos.length} parcelas).` : 'Lançamento apagado.'); S.nota = null; ir(S.voltarPara);
  } catch (e) { toast(e.message); }
}

/* ---------- mercado ---------- */
const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const slugN = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// "leite" casa com "Leite Integral Itambé 1L"
const casa = (curto, longo) => { const a = slugN(curto).split(' ').filter(w => w.length > 1), b = ' ' + slugN(longo) + ' '; return a.length > 0 && a.every(w => b.includes(' ' + w)); };
const qtdLabel = (q, un) => `${num.format(q)} ${un === 'un' ? 'un' : un}`;
S.mk = { lista: [], compra: null, precos: null, carregado: false };
S.etq = null;

async function carregarMercado() {
  // em sequência: a primeira leitura do mercado pode importar o histórico antigo antes dos preços
  const m = await api('mercado'), p = S.mk.precos ? null : await api('precos');
  S.mk.lista = m.lista; S.mk.compra = m.compra; if (p) S.mk.precos = p.precos; S.mk.carregado = true;
  atualizarBadge();
}
function atualizarBadge() {
  const pend = S.mk.lista.filter(l => !l.feito).length, b = $('#b-mercado');
  b.hidden = !S.mk.compra && !pend; b.textContent = S.mk.compra ? (S.mk.compra.itens.length || '•') : pend;
}
function infoPreco(nome) {
  if (!nome || !S.mk.precos?.length) return null;
  const k = slugN(nome);
  let p = S.mk.precos.find(x => slugN(x.nome) === k);
  if (!p) { const c = S.mk.precos.filter(x => casa(nome, x.nome) || casa(x.nome, nome)); p = c.sort((a, b) => (b.hist.at(-1)?.data || '').localeCompare(a.hist.at(-1)?.data || ''))[0]; }
  if (!p?.hist.length) return null;
  const ult = p.hist.at(-1), min = p.hist.reduce((m, h) => h.preco < m.preco ? h : m);
  return { p, ult, min };
}
// A nota fiscal abrevia ("ACUCAR CR SONORA 2KG") e a etiqueta escreve por extenso ("Açúcar Cristal Sonora 2kg"):
// junta os dois num produto só, com o nome mais legível e o histórico das duas fontes.
const legivel = n => (/[a-z]/.test(n) ? 1000 : 0) + n.length;
// siglas comuns nas descrições de NFC-e
const SIGLAS = [[/^st /, 'sabonete '], [/^d a /, 'desodorante aerosol '], [/^cd /, 'creme dental '], [/^ed /, 'escova dental '], [/^ph /, 'papel higienico '],
  [/^sup alim /, ''], [/^beb refrig /, 'refrigerante '], [/^beb energ /, 'energetico '], [/^agua min /, 'agua mineral '], [/^cr leit /, 'creme leite '], [/^ol soj /, 'oleo soja '],
  [/^lav lou /, 'lava loucas '], [/^lav roup /, 'lava roupas '], [/^pap /, 'papel '], [/^filtr /, 'filtro '], [/^salg /, 'salgadinho '], [/^ling /, 'linguica '], [/^mant /, 'manteiga '],
  [/^iog /, 'iogurte '], [/^bisc /, 'biscoito '], [/^choc /, 'chocolate '], [/^achoc /, 'achocolatado '], [/^cerv /, 'cerveja '], [/^amac /, 'amaciante '], [/ f dupla /, ' folha dupla '],
  [/ bco /, ' branco '], [/ gde\b/, ' grande']];
const normP = s => {
  let t = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/(\d),(\d)/g, '$1.$2').replace(/(\d) (\d{1,3})(kg|g|ml|l)\b/g, '$1.$2$3').replace(/[^a-z0-9.]+/g, ' ').trim() + ' ';
  for (const [re, por] of SIGLAS) t = t.replace(re, por);
  return t.trim();
};
const medida = t => /^\d+(\.\d+)?(g|kg|ml|l|lt|m)$/.test(t);
const bateToken = (t, u) => u === t || (t.length >= 2 && u.startsWith(t)) || (u.length >= 3 && t.startsWith(u)) || (t.length >= 4 && u.includes(t)) || (u.length >= 5 && t.includes(u));
// 0 = produtos diferentes; quanto maior, mais parecidos. O tamanho da embalagem precisa bater.
function parecido(a, b) {
  const ta = normP(a).split(' '), tb = normP(b).split(' ');
  const [cur, lon] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const mc = cur.filter(medida), ml = lon.filter(medida);
  if (mc.length && ml.length && !mc.some(m => ml.includes(m))) return 0;
  const pal = cur.filter(t => !medida(t) && !/^\d+$/.test(t) && t.length > 1);
  if (!pal.length || !lon.some(u => bateToken(pal[0], u))) return 0;
  const r = pal.filter(t => lon.some(u => bateToken(t, u))).length / pal.length;
  return r >= 0.6 ? r + pal.filter(t => lon.includes(t)).length * 0.01 : 0;
}
const estiloNota = n => !/[a-z]/.test(n); // descrição em maiúsculas, como vem da nota fiscal
function produtosUnicos() {
  const grupos = [];
  const ordem = [...(S.mk.precos || [])].sort((a, b) => legivel(b.nome) - legivel(a.nome));
  for (const p of ordem) {
    // dois nomes por extenso diferentes são produtos diferentes; só a abreviação da nota se junta a outro
    let g = null, melhor = 0;
    for (const x of grupos) {
      if (x.un !== p.un || (!estiloNota(p.nome) && !estiloNota(x.nome))) continue;
      const sc = parecido(p.nome, x.nome); if (sc > melhor) { melhor = sc; g = x; }
    }
    if (g) g.hist.push(...p.hist);
    else grupos.push({ nome: p.nome, cat: p.cat, un: p.un, hist: [...p.hist] });
  }
  for (const g of grupos) {
    // a mesma compra registrada pela nota e pelo caderno/etiqueta conta uma vez: no dia em que há nota, vale a nota
    g.hist = g.hist.filter(h => h.origem === 'nfce' || !g.hist.some(o => o.origem === 'nfce' && o.data === h.data));
    g.hist.sort((a, b) => a.data.localeCompare(b.data));
    const dias = [...new Set(g.hist.map(h => h.data))];
    g.ult = g.hist.at(-1); g.min = g.hist.reduce((m, h) => h.preco < m.preco ? h : m); g.max = g.hist.reduce((m, h) => h.preco > m.preco ? h : m);
    g.vezes = dias.length;
    g.intervalo = dias.length >= 2 ? (Date.parse(dias.at(-1)) - Date.parse(dias[0])) / 864e5 / (dias.length - 1) : null;
    g.desde = (Date.now() - Date.parse(g.ult.data + 'T12:00')) / 864e5;
    g.repor = g.intervalo >= 2 && g.desde / g.intervalo >= 0.85;
  }
  return grupos;
}
// Todo produto já comprado vira sugestão; os que estão na hora de repor vêm primeiro.
function sugestoes() {
  const naLista = S.mk.lista.filter(l => !l.feito);
  const ordemCat = Object.fromEntries(CATEGORIAS.map((c, i) => [c.id, i]));
  return produtosUnicos()
    .filter(p => !naLista.some(l => casa(l.nome, p.nome) || casa(p.nome, l.nome) || parecido(l.nome, p.nome)))
    .sort((a, b) => (b.repor - a.repor) || (ordemCat[a.cat] - ordemCat[b.cat]) || a.nome.localeCompare(b.nome));
}
const qtdSugerida = p => p.un === 'un' ? Math.max(1, Math.round(p.ult.qtd)) : 1;
const qtdNoCarrinho = (listaId, itens) => (itens || []).filter(i => i.listaId === listaId).reduce((s, i) => s + (i.un === 'un' ? i.qtd : 1), 0);

async function renderMercado() {
  if (!S.mk.carregado) { $('#mk-lista').innerHTML = '<div class="empty"><div class="spinner"></div></div>'; }
  try { await carregarMercado(); } catch (e) { $('#mk-lista').innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }
  if (S.view !== 'mercado') return;
  desenharMercado();
}
function desenharMercado() {
  const c = S.mk.compra;
  $('#mk-planejar').hidden = !!c; $('#mk-comprando').hidden = !c;
  $('#dl-produtos').innerHTML = (S.mk.precos || []).map(p => `<option value="${esc(p.nome)}">`).join('');
  $('#dl-lojas').innerHTML = [...new Set((S.mk.precos || []).flatMap(p => p.hist.map(h => h.loja)).filter(Boolean))].map(l => `<option value="${esc(l)}">`).join('');
  barraMercado();
  if (c) return desenharCompra();
  const aba = S.mk.aba || 'lista';
  document.querySelectorAll('[data-act="mk-aba"]').forEach(x => x.setAttribute('aria-pressed', x.dataset.aba === aba));
  $('#mk-aba-lista').hidden = aba !== 'lista'; $('#mk-aba-hist').hidden = aba !== 'hist'; $('#f-comecar').hidden = aba !== 'lista';
  return aba === 'lista' ? desenharLista() : desenharHistorico();
}

/* histórico: compras (agrupadas por dia e mercado) e produtos */
const NOME_ORIGEM = { nfce: 'nota fiscal', etiqueta: 'etiquetas', caderno: 'caderno' };
function comprasDoHistorico(produtos) {
  const mapa = new Map();
  for (const p of produtos) for (const h of p.hist) {
    const k = h.data + '|' + (h.loja || '');
    if (!mapa.has(k)) mapa.set(k, { data: h.data, loja: h.loja || 'Mercado', origens: new Set(), itens: [] });
    const c = mapa.get(k); c.origens.add(h.origem); c.itens.push({ nome: p.nome, cat: p.cat, un: p.un, preco: h.preco, qtd: h.qtd });
  }
  // no mesmo dia, a compra das etiquetas/caderno e a nota fiscal são a mesma ida ao mercado:
  // vale a lista de itens da nota (o registro completo), com o nome de mercado que vocês digitaram
  const compras = [...mapa.values()];
  for (const nf of compras.filter(c => c.origens.has('nfce'))) {
    const par = compras.find(c => c !== nf && c.data === nf.data && !c.origens.has('nfce') && !c.juntada);
    if (!par) continue;
    nf.loja = par.loja; par.juntada = true;
  }
  return compras.filter(c => !c.juntada).map(c => ({ ...c, total: c.itens.reduce((s, i) => s + i.preco * i.qtd, 0) })).sort((a, b) => b.data.localeCompare(a.data) || b.total - a.total);
}
function desenharHistorico() {
  const h = S.mk.hist || 'compras', q = slugN($('#mk-busca').value);
  document.querySelectorAll('[data-act="mk-hist"]').forEach(x => x.setAttribute('aria-pressed', x.dataset.h === h));
  const produtos = produtosUnicos(), alvo = $('#mk-hist');
  if (!produtos.length) { alvo.innerHTML = '<div class="card"><div class="empty"><strong>Nenhuma compra ainda</strong><span>As compras feitas pelo Mercado e as notas fiscais lidas aparecem aqui, com os preços de cada produto.</span></div></div>'; return; }
  if (h === 'compras') {
    const compras = comprasDoHistorico(produtos).filter(c => !q || slugN(c.loja).includes(q) || c.itens.some(i => slugN(i.nome).includes(q)));
    alvo.innerHTML = compras.length ? compras.map(c => `<details class="hist"><summary>
        <div class="body"><div class="name"><strong>${esc(c.loja)}</strong>${[...c.origens].map(o => `<span class="origem">${esc(NOME_ORIGEM[o] || o)}</span>`).join('')}</div><div class="small muted">${esc(fmtDia(c.data))} · ${c.itens.length} produtos</div></div>${tag(c.total, 'lg')}</summary>
        <div class="inner"><div class="tbl"><table><thead><tr><th>Produto</th><th class="r">Qtd.</th><th class="r">Preço</th><th class="r">Total</th></tr></thead><tbody>
        ${c.itens.sort((a, b) => a.nome.localeCompare(b.nome)).map(i => `<tr><td>${esc(i.nome)}</td><td class="r">${qtdLabel(i.qtd, i.un)}</td><td class="r">${brl.format(i.preco)}</td><td class="r">${brl.format(i.preco * i.qtd)}</td></tr>`).join('')}
        </tbody></table></div>
        <button class="btn" data-act="mk-repetir" data-compra="${esc(c.data + '|' + c.loja)}">Pôr todos estes produtos na lista</button></div></details>`).join('')
      : '<div class="card"><div class="empty"><strong>Nada encontrado</strong><span>Tente outro nome.</span></div></div>';
    S.mk.ultimasCompras = compras;
  } else {
    const lista = produtos.filter(p => !q || slugN(p.nome).includes(q)).sort((a, b) => b.ult.data.localeCompare(a.ult.data) || a.nome.localeCompare(b.nome));
    alvo.innerHTML = lista.length ? lista.map(p => {
      const ant = p.hist.at(-2), d = ant ? (p.ult.preco - ant.preco) / ant.preco : 0;
      return `<details class="hist"><summary>${catDot(p.cat)}<div class="body"><div class="name"><strong>${esc(p.nome)}</strong></div>
        <div class="small muted">${esc(nomeCat(p.cat))} · ${p.vezes}× · menor ${brl.format(p.min.preco)} · maior ${brl.format(p.max.preco)}</div></div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${tag(p.ult.preco)}${Math.abs(d) >= 0.01 ? `<span class="pill ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${Math.round(d * 100)}%</span>` : ''}</div></summary>
        <div class="inner"><div class="tbl"><table><thead><tr><th>Data</th><th>Mercado</th><th class="r">Preço</th><th class="r">Qtd.</th></tr></thead><tbody>
        ${[...p.hist].reverse().map(x => `<tr><td>${esc(fmtDia(x.data))}</td><td>${esc(x.loja || '')}</td><td class="r">${brl.format(x.preco)}</td><td class="r">${num.format(x.qtd)}</td></tr>`).join('')}
        </tbody></table></div>
        <button class="btn" data-act="mk-sug" data-nome="${esc(p.nome)}" data-cat="${p.cat}" data-qtd="${qtdSugerida(p)}">Pôr na lista</button></div></details>`;
    }).join('') : '<div class="card"><div class="empty"><strong>Nada encontrado</strong><span>Tente outro nome.</span></div></div>';
  }
}
$('#mk-busca').addEventListener('input', desenharHistorico);
function barraMercado() {
  const c = S.mk.compra, mostrar = !!c && S.view === 'mercado';
  $('#mk-barra').hidden = !mostrar; document.body.classList.toggle('com-barra', mostrar);
  if (!mostrar) return;
  const total = c.itens.reduce((s, i) => s + i.preco * i.qtd, 0), un = c.itens.filter(i => i.un === 'un').reduce((s, i) => s + i.qtd, 0);
  $('#mk-barra-total').innerHTML = tag(total, 'lg');
  $('#mk-barra-meta').textContent = `${c.itens.length} ${c.itens.length === 1 ? 'produto' : 'produtos'} · ${num.format(un)} un`;
  $('#mk-total-top').innerHTML = tag(total, 'xl');
}
function metaLista(l) {
  const ip = infoPreco(l.nome), partes = [qtdLabel(l.qtd, ip?.p.un || 'un')];
  if (ip) { partes.push('~' + brl.format(ip.ult.preco * l.qtd)); if (ip.min.preco < ip.ult.preco - 0.009) partes.push(`menor: ${brl.format(ip.min.preco)} no ${ip.min.loja}`); }
  return esc(partes.join(' · '));
}
function desenharLista() {
  const L = S.mk.lista;
  let est = 0; L.filter(l => !l.feito).forEach(l => { const ip = infoPreco(l.nome); if (ip) est += ip.ult.preco * l.qtd; });
  const pend = L.filter(l => !l.feito).length;
  $('#mk-lista-sum').innerHTML = pend ? `${pend} ${pend === 1 ? 'item' : 'itens'}${est ? ` · estimativa <strong>${brl.format(est)}</strong>` : ''}` : '';
  if (!L.length) $('#mk-lista').innerHTML = '<div class="empty"><strong>Lista vazia</strong><span>Adicione o que precisa comprar. Você e sua esposa veem a mesma lista.</span></div>';
  else {
    const grupos = {}; L.forEach(l => (grupos[l.cat] ||= []).push(l));
    $('#mk-lista').innerHTML = CATEGORIAS.filter(c => grupos[c.id]).map(c => `<div class="cat-h">${catDot(c.id)}${esc(c.nome)}</div>` + grupos[c.id].map(l => `
      <div class="li${l.feito ? ' feito' : ''}">
        <button class="check" data-act="mk-marcar" data-id="${l.id}" aria-pressed="${l.feito}" aria-label="Marcar ${esc(l.nome)}">${ICON_CHECK}</button>
        <div class="body"><div class="name">${esc(l.nome)}</div><div class="meta">${metaLista(l)}</div></div>
        <div class="stepper"><button data-act="mk-lqtd" data-id="${l.id}" data-d="-1" aria-label="Menos">−</button><span>${num.format(l.qtd)}</span><button data-act="mk-lqtd" data-id="${l.id}" data-d="1" aria-label="Mais">+</button></div>
        <button class="x" data-act="mk-lrm" data-id="${l.id}" aria-label="Remover ${esc(l.nome)}">×</button>
      </div>`).join('')).join('') + (L.some(l => l.feito) ? '<button class="btn ghost" data-act="mk-limpar" style="margin-top:8px">Limpar itens riscados</button>' : '');
  }
  desenharSugestoes();
}
function desenharSugestoes() {
  const sg = sugestoes(), repor = sg.filter(p => p.repor).length;
  $('#mk-sug-card').hidden = !sg.length;
  $('#mk-sug-sum').textContent = `${sg.length} ${sg.length === 1 ? 'produto já comprado' : 'produtos já comprados'}${repor ? ` · ${repor} na hora de repor` : ''}. Toque em + para pôr na lista.`;
  const LIMITE = 15, mostrar = S.mk.verTodasSug ? sg : sg.slice(0, LIMITE);
  let html = '', cat = null;
  for (const p of mostrar) {
    const grupo = p.repor ? 'repor' : p.cat;
    if (grupo !== cat) { cat = grupo; html += p.repor ? '<div class="cat-h">Na hora de repor</div>' : `<div class="cat-h">${catDot(p.cat)}${esc(nomeCat(p.cat))}</div>`; }
    const meta = [`${brl.format(p.ult.preco)}${p.un !== 'un' ? '/' + p.un : ''}`, `última: ${fmtDia(p.ult.data)}`, p.intervalo ? `a cada ~${Math.round(p.intervalo)} dias` : null].filter(Boolean).join(' · ');
    html += `<div class="sug-li"><div class="body"><div class="name">${esc(p.nome)}</div><div class="meta">${esc(meta)}</div></div>
      <button class="btn ghost" data-act="mk-sug" data-nome="${esc(p.nome)}" data-cat="${p.cat}" data-qtd="${qtdSugerida(p)}" aria-label="Pôr ${esc(p.nome)} na lista">+ ${num.format(qtdSugerida(p))}</button></div>`;
  }
  if (sg.length > LIMITE) html += `<button class="btn ghost" data-act="mk-sug-mais" style="margin-top:6px">${S.mk.verTodasSug ? 'Mostrar menos' : `Ver todas as ${sg.length} sugestões`}</button>`;
  $('#mk-sug').innerHTML = html;
}
function desenharCompra() {
  const c = S.mk.compra, itens = c.itens;
  $('#mk-loja-nome').textContent = c.loja;
  $('#mk-inicio').textContent = `Começou às ${new Date(c.inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · ${c.por}`;
  if (!$('#mk-quem').value) $('#mk-quem').value = meuNome();
  if (!$('#mk-pag').options.length) montarPagamento('mk', { pagamento: 'Cartão de Débito' }); else atualizarPagamento('mk');
  const L = S.mk.lista;
  $('#mk-hoje-card').hidden = !L.length;
  $('#mk-hoje-sum').textContent = L.length ? `${L.filter(l => l.feito).length} de ${L.length} riscados` : '';
  $('#mk-hoje').innerHTML = L.map(l => { const got = qtdNoCarrinho(l.id, itens); return `<div class="li${l.feito ? ' feito' : ''}">
    <button class="check" data-act="mk-marcar" data-id="${l.id}" aria-pressed="${l.feito}" aria-label="Marcar ${esc(l.nome)}">${ICON_CHECK}</button>
    <div class="body"><div class="name">${esc(l.nome)}</div><div class="meta">${metaLista(l)}</div></div>${got ? `<span class="progresso">${num.format(got)} de ${num.format(l.qtd)}</span>` : ''}</div>`; }).join('');
  $('#mk-cart-sum').textContent = itens.length ? `${itens.length} ${itens.length === 1 ? 'produto' : 'produtos'}` : '';
  $('#mk-cart').innerHTML = itens.length ? [...itens].reverse().map(i => `<div class="li">
      <div class="body"><div class="name">${esc(i.nome)}</div><div class="meta">${qtdLabel(i.qtd, i.un)} × ${brl.format(i.preco)}${i.un !== 'un' ? '/' + i.un : ''}</div></div>
      ${i.un === 'un' ? `<div class="stepper"><button data-act="mk-cqtd" data-id="${i.id}" data-d="-1" aria-label="Menos">−</button><span>${num.format(i.qtd)}</span><button data-act="mk-cqtd" data-id="${i.id}" data-d="1" aria-label="Mais">+</button></div>` : ''}
      ${tag(i.preco * i.qtd)}
      <button class="x" data-act="mk-crm" data-id="${i.id}" aria-label="Tirar ${esc(i.nome)}">×</button></div>`).join('')
    : '<div class="empty"><strong>Carrinho vazio</strong><span>Toque em “Fotografar etiqueta” ao pegar cada produto.</span></div>';
  barraMercado(); atualizarBadge();
}

// Salva o carrinho um pedido por vez; se chegarem mudanças no meio, envia só a última.
let salvandoCarrinho = false, carrinhoPendente = false;
async function salvarCarrinho() {
  if (salvandoCarrinho) { carrinhoPendente = true; return; }
  salvandoCarrinho = true;
  try {
    do { carrinhoPendente = false; const c = S.mk.compra; if (!c) break; await api('mercado/compra', { method: 'PUT', body: { id: c.id, itens: c.itens } }); } while (carrinhoPendente);
  } catch (e) { toast(e.message); if (/finalizada ou cancelada/.test(e.message)) { S.mk.carregado = false; renderMercado(); } }
  finally { salvandoCarrinho = false; }
}
// Risca (ou desrisca) da lista o que entrou (ou saiu) do carrinho.
function sincronizarLista() {
  const itens = S.mk.compra?.itens || [];
  for (const l of S.mk.lista) {
    const got = qtdNoCarrinho(l.id, itens);
    if (!got && !l.porCarrinho) continue;
    const coberto = got >= l.qtd;
    if (coberto !== l.feito) { l.feito = coberto; l.porCarrinho = coberto; api('mercado/lista/' + l.id, { method: 'PUT', body: { feito: coberto, porCarrinho: coberto } }).catch(() => {}); }
  }
}
function mudarCarrinho(itens) { S.mk.compra.itens = itens; sincronizarLista(); desenharCompra(); salvarCarrinho(); }

/* etiqueta */
async function reduzirFoto(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1280 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
function abrirEtiqueta(file) {
  S.etq = { foto: null, promo: null, listaTocada: false };
  $('#etq-nome').value = ''; $('#etq-preco').value = ''; $('#etq-un').value = 'un'; $('#etq-qtd').value = '1';
  $('#etq-cat').innerHTML = CATEGORIAS.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join(''); $('#etq-cat').value = 'mercado';
  const itens = S.mk.compra.itens;
  $('#etq-lista').innerHTML = '<option value="">Não está na lista</option>' + S.mk.lista.filter(l => !l.feito || qtdNoCarrinho(l.id, itens)).map(l => `<option value="${l.id}">${esc(l.nome)}${l.qtd > 1 ? ` (${num.format(l.qtd)})` : ''}</option>`).join('');
  $('#etq-reler').hidden = true; $('#etq-img').hidden = !file;
  $('#f-etq').hidden = false; compararEtiqueta();
  $('#f-etq').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!file) { statusEtq('Preencha os dados do produto.'); $('#etq-nome').focus(); return; }
  $('#etq-img').src = URL.createObjectURL(file);
  reduzirFoto(file).then(foto => { S.etq.foto = foto; lerEtq(false); }).catch(() => statusEtq('Não consegui abrir a foto. Preencha à mão.'));
}
function statusEtq(t, girando) { $('#etq-status').innerHTML = (girando ? '<span class="spinner"></span>' : '') + `<span>${esc(t)}</span>`; }
async function lerEtq(cuidado) {
  const etq = S.etq; if (!etq?.foto) return;
  statusEtq(cuidado ? 'Lendo com mais atenção…' : 'Lendo a etiqueta…', true); $('#etq-reler').hidden = true;
  try {
    const { etiqueta: r } = await api('etiqueta', { method: 'POST', body: { imagem: etq.foto, cuidado } });
    if (S.etq !== etq) return;
    if (r.descricao) $('#etq-nome').value = r.descricao;
    if (r.preco) $('#etq-preco').value = r.preco.toFixed(2).replace('.', ',');
    $('#etq-un').value = r.unidade; $('#etq-cat').value = r.categoria;
    etq.promo = r.preco_normal;
    statusEtq(r.confianca === 'baixa' || !r.preco ? 'Leitura incerta. Confira os campos.' : 'Etiqueta lida. Confira e ajuste a quantidade.');
    escolherDaLista(); compararEtiqueta();
  } catch (e) { if (S.etq === etq) statusEtq(e.message); }
  if (S.etq === etq) $('#etq-reler').hidden = false;
}
function escolherDaLista() {
  if (S.etq?.listaTocada) return;
  const nome = $('#etq-nome').value, itens = S.mk.compra?.itens || [];
  const cand = S.mk.lista.filter(l => !l.feito || qtdNoCarrinho(l.id, itens));
  const m = cand.find(l => slugN(l.nome) === slugN(nome)) || cand.find(l => !l.feito && (casa(l.nome, nome) || casa(nome, l.nome))) || cand.find(l => casa(l.nome, nome) || casa(nome, l.nome));
  $('#etq-lista').value = m ? m.id : '';
}
function compararEtiqueta() {
  const preco = parseBR($('#etq-preco').value), qtd = parseBR($('#etq-qtd').value) || 0;
  $('#etq-total').innerHTML = isFinite(preco) ? tag(preco * qtd).replace(/^<span class="tag ">|<\/span>$/g, '') : '<small>R$</small>–';
  const ip = infoPreco($('#etq-nome').value), linhas = [];
  if (S.etq?.promo && isFinite(preco)) linhas.push(`<span><span class="pill down">Promoção</span> de ${brl.format(S.etq.promo)} por ${brl.format(preco)}</span>`);
  if (ip && isFinite(preco)) {
    const d = (preco - ip.ult.preco) / ip.ult.preco;
    linhas.push(`<span>${Math.abs(d) < 0.01 ? '<span class="pill">mesmo preço</span>' : `<span class="pill ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${Math.round(d * 100)}%</span>`} Última vez: ${brl.format(ip.ult.preco)} no ${esc(ip.ult.loja)}, ${fmtDia(ip.ult.data)}</span>`);
    if (ip.min.preco < preco - 0.009) linhas.push(`<span>Menor preço que vocês já pagaram: <strong>${brl.format(ip.min.preco)}</strong> no ${esc(ip.min.loja)}</span>`);
  }
  $('#etq-comp').innerHTML = linhas.join('');
}
['#etq-nome', '#etq-preco', '#etq-qtd'].forEach(id => $(id).addEventListener('input', compararEtiqueta));
$('#etq-nome').addEventListener('input', escolherDaLista);
$('#etq-lista').addEventListener('change', () => { if (S.etq) S.etq.listaTocada = true; });
$('#mk-foto').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) abrirEtiqueta(f); });
$('#f-etq').addEventListener('submit', e => {
  e.preventDefault();
  const nome = $('#etq-nome').value.trim(), preco = parseBR($('#etq-preco').value), qtd = parseBR($('#etq-qtd').value), un = $('#etq-un').value;
  if (!nome) return $('#etq-nome').focus();
  if (!(preco > 0)) { toast('Informe o preço, por exemplo 12,90.'); return $('#etq-preco').focus(); }
  if (!(qtd > 0)) { toast('Informe a quantidade.'); return $('#etq-qtd').focus(); }
  const listaId = $('#etq-lista').value || null, cents = r2(preco), itens = [...S.mk.compra.itens];
  // mesmo produto pelo mesmo preço: soma a quantidade na linha existente
  const ig = itens.findIndex(i => slugN(i.nome) === slugN(nome) && i.un === un && i.preco === cents);
  let msg;
  if (ig >= 0) { itens[ig] = { ...itens[ig], qtd: Math.round((itens[ig].qtd + qtd) * 1000) / 1000, listaId: listaId || itens[ig].listaId }; msg = `Somado: agora ${qtdLabel(itens[ig].qtd, un)}.`; }
  else { itens.push({ id: Math.random().toString(36).slice(2, 10), nome, preco: cents, qtd, un, cat: $('#etq-cat').value, listaId }); msg = 'Pôs no carrinho.'; }
  S.etq = null; $('#f-etq').hidden = true;
  mudarCarrinho(itens);
  const l = listaId && S.mk.lista.find(x => x.id === listaId);
  toast(l ? (l.feito ? `${msg} “${l.nome}” riscado da lista.` : `${msg} ${num.format(qtdNoCarrinho(l.id, itens))} de ${num.format(l.qtd)} de “${l.nome}”.`) : msg);
});
$('#f-lista').addEventListener('submit', async e => {
  e.preventDefault();
  const nome = $('#l-nome').value.trim(); if (!nome) return;
  const qtd = parseBR($('#l-qtd').value) || 1;
  try {
    const { item } = await api('mercado/lista', { method: 'POST', body: { nome, qtd } });
    S.mk.lista.push(item); $('#l-nome').value = ''; $('#l-qtd').value = '1'; $('#l-nome').focus();
    desenharLista(); atualizarBadge();
  } catch (err) { toast(err.message); }
});
$('#f-comecar').addEventListener('submit', async e => {
  e.preventDefault();
  try { const { compra } = await api('mercado/compra', { method: 'POST', body: { loja: $('#mk-loja').value.trim() } }); S.mk.compra = compra; $('#mk-loja').value = ''; desenharMercado(); window.scrollTo(0, 0); }
  catch (err) { toast(err.message); }
});
async function finalizarCompra(btn) {
  const c = S.mk.compra; btn.disabled = true;
  try {
    await salvarCarrinho();
    const r = await api('mercado/compra/finalizar', { method: 'POST', body: { id: c.id, quem: $('#mk-quem').value.trim() || meuNome(), ...lerPagamento('mk') } });
    S.mk.compra = null; S.mk.precos = null; S.mk.carregado = false;
    if (r.vazia) { toast('Compra vazia descartada.'); return renderMercado(); }
    adicionarAoCache(r.gasto); S.mes = r.gasto.data.slice(0, 7);
    document.body.classList.remove('com-barra'); $('#mk-barra').hidden = true;
    toast(`Compra de ${brl.format(r.gasto.total)} lançada nos gastos do mês.`);
    ir('resumo');
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act^="mk-"],[data-act^="etq-"]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id, L = S.mk.lista;
  const salvarItem = (l, mud) => api('mercado/lista/' + l.id, { method: 'PUT', body: mud }).catch(err => toast(err.message));
  if (a === 'mk-marcar') { const l = L.find(x => x.id === id); if (!l) return; l.feito = !l.feito; l.porCarrinho = false; salvarItem(l, { feito: l.feito, porCarrinho: false }); return S.mk.compra ? desenharCompra() : desenharLista(); }
  if (a === 'mk-lqtd') { const l = L.find(x => x.id === id); if (!l) return; l.qtd = Math.max(1, l.qtd + +b.dataset.d); salvarItem(l, { qtd: l.qtd }); return desenharLista(); }
  if (a === 'mk-lrm') { S.mk.lista = L.filter(x => x.id !== id); api('mercado/lista/' + id, { method: 'DELETE' }).catch(err => toast(err.message)); desenharLista(); return atualizarBadge(); }
  if (a === 'mk-limpar') { L.filter(x => x.feito).forEach(x => api('mercado/lista/' + x.id, { method: 'DELETE' }).catch(() => {})); S.mk.lista = L.filter(x => !x.feito); return desenharLista(); }
  if (a === 'mk-sug') {
    b.disabled = true;
    api('mercado/lista', { method: 'POST', body: { nome: b.dataset.nome, cat: b.dataset.cat, qtd: +b.dataset.qtd || 1 } })
      .then(({ item }) => { S.mk.lista.push(item); desenharLista(); atualizarBadge(); toast(`“${item.nome}” na lista.`); })
      .catch(err => { b.disabled = false; toast(err.message); });
    return;
  }
  if (a === 'mk-sug-todos') {
    if (!confirmado(b)) return;
    const todos = sugestoes(); b.disabled = true;
    (async () => { for (const p of todos) { const { item } = await api('mercado/lista', { method: 'POST', body: { nome: p.nome, cat: p.cat, qtd: qtdSugerida(p) } }); S.mk.lista.push(item); } })()
      .then(() => toast(`${todos.length} itens na lista. Tire o que não precisar.`)).catch(err => toast(err.message))
      .finally(() => { b.disabled = false; desenharLista(); atualizarBadge(); });
    return;
  }
  if (a === 'mk-repetir') {
    const c = (S.mk.ultimasCompras || []).find(x => x.data + '|' + x.loja === b.dataset.compra); if (!c) return;
    const naLista = S.mk.lista.filter(l => !l.feito);
    const novos = [...new Map(c.itens.filter(i => !naLista.some(l => casa(l.nome, i.nome) || casa(i.nome, l.nome))).map(i => [slugN(i.nome), i])).values()];
    b.disabled = true;
    (async () => { for (const i of novos) { const { item } = await api('mercado/lista', { method: 'POST', body: { nome: i.nome, cat: i.cat, qtd: i.un === 'un' ? Math.max(1, Math.round(i.qtd)) : 1 } }); S.mk.lista.push(item); } })()
      .then(() => { toast(`${novos.length} produtos na lista.`); S.mk.aba = 'lista'; desenharMercado(); atualizarBadge(); })
      .catch(err => toast(err.message)).finally(() => { b.disabled = false; });
    return;
  }
  if (a === 'mk-sug-mais') { S.mk.verTodasSug = !S.mk.verTodasSug; return desenharSugestoes(); }
  if (a === 'mk-aba') { S.mk.aba = b.dataset.aba; return desenharMercado(); }
  if (a === 'mk-hist') { S.mk.hist = b.dataset.h; return desenharHistorico(); }
  if (a === 'mk-manual') return abrirEtiqueta(null);
  if (a === 'etq-descartar') { S.etq = null; $('#f-etq').hidden = true; return; }
  if (a === 'etq-reler') return lerEtq(true);
  if (a === 'mk-cqtd') return mudarCarrinho(S.mk.compra.itens.map(i => i.id === id ? { ...i, qtd: Math.max(1, i.qtd + +b.dataset.d) } : i));
  if (a === 'mk-crm') return mudarCarrinho(S.mk.compra.itens.filter(i => i.id !== id));
  if (a === 'mk-cancelar') { if (!confirmado(b)) return; api('mercado/compra', { method: 'DELETE' }).then(() => { S.mk.compra = null; toast('Compra cancelada.'); desenharMercado(); }).catch(err => toast(err.message)); return; }
  if (a === 'mk-finalizar') { if (!confirmado(b)) return; return finalizarCompra(b); }
});

/* ---------- receitas ---------- */
const nomeTipo = id => S.tiposReceita.find(t => t.id === id)?.nome || 'Outras receitas';
const corTipo = id => S.tiposReceita.find(t => t.id === id)?.cor || '#7D8791';
S.rc = { tipo: 'salario', editando: null };
async function renderReceitas() {
  const mes = S.mes;
  $('#rc-mes').textContent = nomeMes(mes);
  if (!S.receitas[mes]) { $('#rc-total').innerHTML = '<div class="spinner"></div>'; $('#rc-lista').innerHTML = ''; $('#rc-tipos').innerHTML = ''; $('#rc-saldo').textContent = ''; }
  if (!S.rc.editando) prepararFormReceita();
  let lista, gastos;
  try { [lista, gastos] = await Promise.all([carregarReceitas(mes), carregarMes(mes)]); }
  catch (e) { $('#rc-total').innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }
  if (S.view !== 'receitas' || S.mes !== mes) return;
  const total = somaR(lista), gasto = somaG(gastos), saldo = total - gasto;
  $('#rc-total').innerHTML = tag(total, 'xl rec');
  $('#rc-saldo').innerHTML = total > 0 || gasto > 0 ? `Gastos do mês: ${brl.format(gasto)} · <strong class="${saldo < 0 ? 'up' : 'down'}">Saldo ${brl.format(saldo)}</strong>` : '';
  const tipos = {}; for (const r of lista) tipos[r.tipo] = (tipos[r.tipo] || 0) + r.valor;
  const ord = Object.entries(tipos).sort((a, b) => b[1] - a[1]);
  $('#rc-tipos-card').hidden = !ord.length;
  $('#rc-tipos').innerHTML = ord.map(([t, v]) => `<div class="bar" style="cursor:default"><span class="nm"><span class="dot" style="background:${corTipo(t)}"></span>${esc(nomeTipo(t))}</span><span class="vl">${brl.format(v)}<small>${pct(v, total)}%</small></span><span class="tr"><i style="width:${(v / ord[0][1] * 100).toFixed(1)}%;background:${corTipo(t)}"></i></span></div>`).join('');
  $('#rc-qtd').textContent = lista.length ? `${lista.length} ${lista.length === 1 ? 'receita' : 'receitas'}` : '';
  $('#rc-lista').innerHTML = lista.length ? lista.map(r => `<button class="row${r.previsto ? ' previsto' : ''}" data-act="rc-abrir" data-key="${esc(r.key)}">
      <span class="dot" style="background:${corTipo(r.tipo)}"></span>
      <span class="body"><span class="name">${esc(r.descricao)}${r.origem === 'fixo' ? '<span class="badge-nf">FIXA</span>' : ''}${r.previsto ? '<span class="badge-nf prev">PREVISTA</span>' : ''}</span><br><span class="meta">${esc([fmtDia(r.data), r.quem, nomeTipo(r.tipo)].filter(Boolean).join(' · '))}</span></span>
      <span class="val pos">${brl.format(r.valor)}</span></button>`).join('')
    : `<div class="empty"><strong>Nenhuma receita em ${esc(nomeMes(mes))}</strong><span>Cadastre os salários com “Repetir todo mês” e eles entram sozinhos nos próximos meses.</span></div>`;
  renderReceitasFixas();
}
function prepararFormReceita(r) {
  S.rc.editando = r || null;
  S.rc.tipo = r?.tipo || S.rc.tipo || 'salario';
  $('#rc-form-titulo').textContent = r ? 'Editar receita' : 'Nova receita';
  $('#rc-valor').value = r ? r2(r.valor).toFixed(2).replace('.', ',') : '';
  $('#rc-data').value = r?.data || (S.mes === mesAtual() ? hoje() : S.mes + '-05');
  $('#rc-desc').value = r?.descricao || '';
  $('#rc-quem').value = r?.quem || meuNome();
  $('#rc-repetir').checked = false; $('#rc-repetir-row').hidden = !!r;
  $('#rc-cancelar').hidden = !r; $('#rc-apagar').hidden = !r;
  $('#rc-salvar').textContent = r ? 'Salvar alterações' : 'Salvar receita';
  desenharTiposReceita();
}
function desenharTiposReceita() {
  $('#rc-tipos-chips').innerHTML = S.tiposReceita.map(t => `<button type="button" class="chip" data-act="rc-tipo" data-tipo="${t.id}" aria-pressed="${S.rc.tipo === t.id}"><span class="dot" style="background:${t.cor}"></span>${esc(t.nome)}</button>`).join('');
}
$('#f-receita').addEventListener('submit', async e => {
  e.preventDefault();
  const valor = parseBR($('#rc-valor').value);
  if (!(valor > 0)) { toast('Informe o valor, por exemplo 5.000,00.'); return $('#rc-valor').focus(); }
  const btn = e.submitter; btn.disabled = true;
  const corpo = { valor, data: $('#rc-data').value, descricao: $('#rc-desc').value.trim(), tipo: S.rc.tipo, quem: $('#rc-quem').value.trim() || meuNome(), repetir: $('#rc-repetir').checked };
  try {
    const ed = S.rc.editando;
    const { receita } = ed ? await api(`receitas/${ed.key.split('/')[1]}/${ed.key.split('/')[2]}`, { method: 'PUT', body: corpo }) : await api('receitas', { method: 'POST', body: corpo });
    limparCaches();
    toast(corpo.repetir ? `Receita fixa de ${brl.format(receita.valor)} salva. Ela entra todo mês.` : ed ? 'Receita atualizada.' : `Receita de ${brl.format(receita.valor)} salva.`);
    S.mes = receita.data.slice(0, 7); prepararFormReceita(); renderReceitas();
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});
async function renderReceitasFixas() {
  try {
    const { fixos, mesAtual: m } = await api('rfixos');
    $('#rc-fixos').innerHTML = fixos.length ? fixos.map(f => {
      const parado = f.fim && f.fim < m;
      return `<details class="fixo-det${parado ? ' parado' : ''}"><summary class="fixo-row"><span class="dot" style="background:${corTipo(f.tipo)}"></span><div class="body"><div class="name">${esc(f.descricao)}</div>
        <div class="meta small muted">${esc([f.quem, nomeTipo(f.tipo), 'dia ' + f.dia, parado ? 'parada' : f.fim ? 'até ' + nomeMes(f.fim) : null].filter(Boolean).join(' · '))}</div></div><span class="val">${brl.format(f.valor)}</span></summary>
        <form class="fixo-form" data-rfixo="${f.fid}" autocomplete="off"><div class="grid2">
          <div class="field"><label>Valor (R$)</label><input name="valor" type="text" inputmode="decimal" value="${r2(f.valor).toFixed(2).replace('.', ',')}"></div>
          <div class="field"><label>Dia</label><input name="dia" type="number" min="1" max="31" value="${f.dia}"></div>
          <div class="field"><label>Descrição</label><input name="descricao" type="text" value="${esc(f.descricao)}" maxlength="120"></div>
          <div class="field"><label>De quem</label><input name="quem" type="text" list="dl-quem" value="${esc(f.quem || '')}" maxlength="40"></div>
        </div><p class="muted small" style="margin:0">A mudança vale deste mês em diante.</p>
        <div class="actions">${parado ? `<button class="btn" type="button" data-act="rf-reativar" data-fid="${f.fid}">Voltar a repetir</button>` : `<button class="btn danger" type="button" data-act="rf-parar" data-fid="${f.fid}" data-confirm="Toque de novo para parar">Parar</button>`}<button class="btn primary" type="submit">Salvar</button></div></form></details>`;
    }).join('') : '<p class="muted small" style="margin:0">Nenhuma receita fixa. Ao lançar um salário, marque “Repetir todo mês”.</p>';
  } catch (e) { $('#rc-fixos').innerHTML = `<p class="erro">${esc(e.message)}</p>`; }
}
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-rfixo]'); if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  try { await api('rfixos/' + f.dataset.rfixo, { method: 'PUT', body: { valor: parseBR(d.valor), dia: +d.dia, descricao: d.descricao, quem: d.quem } }); limparCaches(); toast('Receita fixa atualizada.'); renderReceitas(); }
  catch (err) { toast(err.message); }
});

/* ---------- painel (receitas x gastos) ---------- */
function graficoBarras(meses, mesSel) {
  const W = 640, H = 220, pe = 46, pd = 8, pt = 12, pb = 26, n = meses.length;
  const max = Math.max(1, ...meses.map(m => Math.max(m.receitas, m.gastos))), min = Math.min(0, ...meses.map(m => m.receitas - m.gastos));
  const y = v => pt + (max - v) / (max - min) * (H - pt - pb), larg = (W - pe - pd) / n, bw = Math.min(16, larg * .32);
  const passo = max / 4, grade = [0, 1, 2, 3, 4].map(i => i * passo);
  let svg = grade.map(v => `<line x1="${pe}" x2="${W - pd}" y1="${y(v)}" y2="${y(v)}" class="g-grade"/><text x="${pe - 6}" y="${y(v) + 4}" text-anchor="end" class="g-eixo">${v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)}</text>`).join('');
  if (min < 0) svg += `<line x1="${pe}" x2="${W - pd}" y1="${y(0)}" y2="${y(0)}" class="g-zero"/>`;
  const pts = [];
  meses.forEach((m, i) => {
    const cx = pe + larg * i + larg / 2, sel = m.mes === mesSel;
    if (sel) svg += `<rect x="${pe + larg * i + 1}" y="${pt - 6}" width="${larg - 2}" height="${H - pt - pb + 6}" rx="6" class="g-sel"/>`;
    svg += `<rect x="${cx - bw - 1}" y="${y(m.receitas)}" width="${bw}" height="${Math.max(0, y(0) - y(m.receitas))}" rx="2" class="g-rec${m.previsto ? ' prev' : ''}"><title>${nomeMes(m.mes)} · receitas ${brl.format(m.receitas)}</title></rect>`;
    svg += `<rect x="${cx + 1}" y="${y(m.gastos)}" width="${bw}" height="${Math.max(0, y(0) - y(m.gastos))}" rx="2" class="g-gas${m.previsto ? ' prev' : ''}"><title>${nomeMes(m.mes)} · gastos ${brl.format(m.gastos)}</title></rect>`;
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="g-eixo${sel ? ' sel' : ''}">${nomeMes(m.mes).slice(0, 3).toLowerCase()}</text>`;
    if (m.receitas > 0) pts.push([cx, y(m.receitas - m.gastos), m]);
  });
  if (pts.length > 1) svg += `<polyline points="${pts.map(p => p[0] + ',' + p[1]).join(' ')}" class="g-saldo"/>`;
  svg += pts.map(([x, yy, m]) => `<circle cx="${x}" cy="${yy}" r="3.5" class="g-saldo-p"><title>${nomeMes(m.mes)} · saldo ${brl.format(m.receitas - m.gastos)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Receitas e gastos por mês">${svg}</svg>`;
}
async function renderPainel() {
  const mes = S.mes;
  $('#p-mes').textContent = nomeMes(mes);
  if (!S.painel[mes]) { $('#p-kpis').innerHTML = '<div class="card"><div class="spinner"></div></div>'; for (const id of ['#p-grafico', '#p-tabela', '#p-futuro', '#p-parc', '#p-pessoas', '#p-comp']) $(id).innerHTML = ''; }
  let P;
  try { P = S.painel[mes] || (S.painel[mes] = await api('painel?mes=' + mes)); }
  catch (e) { $('#p-kpis').innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }
  if (S.view !== 'painel' || S.mes !== mes) return;
  const atual = P.meses.at(-1), ant = P.meses.at(-2);
  const saldo = atual.receitas - atual.gastos, taxa = atual.receitas > 0 ? saldo / atual.receitas : null;
  const kpi = (k, v, sub, cls = '') => `<div class="card kpi-card ${cls}"><span class="k">${k}</span><strong>${v}</strong><span class="small muted">${sub || ''}</span></div>`;
  const varTxt = (v, a) => a > 0 ? `${v >= a ? '+' : ''}${Math.round((v - a) / a * 100)}% sobre ${nomeMes(ant.mes).split(' ')[0].toLowerCase()}` : '';
  $('#p-kpis').innerHTML = kpi('Receitas', brl.format(atual.receitas), varTxt(atual.receitas, ant.receitas), 'rec') + kpi('Gastos', brl.format(atual.gastos), varTxt(atual.gastos, ant.gastos), 'gas') +
    kpi('Saldo do mês', brl.format(saldo), atual.previsto ? 'previsão' : saldo >= 0 ? 'sobrou' : 'faltou', saldo >= 0 ? 'pos' : 'neg') +
    kpi('Quanto sobrou', taxa == null ? '—' : Math.round(taxa * 100) + '%', taxa == null ? 'cadastre as receitas' : 'da receita do mês', taxa != null && taxa < 0 ? 'neg' : '');
  $('#p-grafico').innerHTML = graficoBarras(P.meses, mes);
  const acum = P.ano.receitas - P.ano.gastos;
  $('#p-tabela').innerHTML = `<table class="compacta"><thead><tr><th>Mês</th><th class="r">Receitas (R$)</th><th class="r">Gastos (R$)</th><th class="r">Saldo (R$)</th></tr></thead><tbody>${P.meses.slice().reverse().filter(m => m.receitas || m.gastos).map(m => `<tr${m.mes === mes ? ' class="sel"' : ''}><td>${esc(mesCurto(m.mes))}${m.previsto ? '*' : ''}</td><td class="r">${n2(m.receitas)}</td><td class="r">${n2(m.gastos)}</td><td class="r ${m.receitas - m.gastos < 0 ? 'neg' : 'pos'}">${n2(m.receitas - m.gastos)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total ${P.ano.ano}</td><td class="r">${n2(P.ano.receitas)}</td><td class="r">${n2(P.ano.gastos)}</td><td class="r ${acum < 0 ? 'neg' : 'pos'}">${n2(acum)}</td></tr></tfoot></table>${P.meses.some(m => m.previsto) ? '<p class="muted small" style="margin:6px 0 0">* previsão (mês que ainda não chegou)</p>' : ''}`;
  $('#p-comp-mes').textContent = nomeMes(mes);
  const comp = [['Gastos fixos', atual.fixos, '#3F6E8C'], ['Parcelas do cartão', atual.parcelas, '#8E44AD'], ['Gastos do dia a dia', atual.variaveis, '#E0662B'], ['Sobrou', Math.max(0, saldo), 'var(--good)']].filter(x => x[1] > 0.004);
  const base = Math.max(atual.receitas, atual.gastos) || 1;
  $('#p-comp').innerHTML = comp.length ? comp.map(([n, v, cor]) => `<div class="bar" style="cursor:default"><span class="nm"><span class="dot" style="background:${cor}"></span>${n}</span><span class="vl">${brl.format(v)}<small>${atual.receitas > 0 ? pct(v, atual.receitas) + '% da receita' : ''}</small></span><span class="tr"><i style="width:${(v / base * 100).toFixed(1)}%;background:${cor}"></i></span></div>`).join('') : '<p class="muted small" style="margin:0">Sem lançamentos neste mês.</p>';
  $('#p-futuro').innerHTML = `<table class="compacta"><thead><tr><th>Mês</th><th class="r">Receitas</th><th class="r">Fixos</th><th class="r">Parcelas</th><th class="r">Sobra</th></tr><tr class="un"><th></th><th class="r" colspan="4">valores em R$</th></tr></thead><tbody>${P.futuro.map(m => `<tr><td>${esc(mesCurto(m.mes))}</td><td class="r">${n2(m.receitas)}</td><td class="r">${n2(m.fixos)}</td><td class="r">${n2(m.parcelas)}</td><td class="r ${m.receitas - m.gastos < 0 ? 'neg' : 'pos'}">${n2(m.receitas - m.gastos)}</td></tr>`).join('')}</tbody></table>
    <p class="muted small" style="margin:8px 0 0">Receitas e gastos fixos já cadastrados, mais as parcelas do cartão. A sobra é o que fica para os gastos do dia a dia.</p>`;
  $('#p-parc-card').hidden = !P.parcelasAbertas.length;
  const totParc = P.parcelasAbertas.reduce((s, a) => s + a.valor, 0);
  $('#p-parc-sum').textContent = P.parcelasAbertas.length ? `${brl.format(totParc)} a pagar` : '';
  $('#p-parc').innerHTML = P.parcelasAbertas.map(a => `<div class="fixo-row"><div class="body"><div class="name">${esc(a.descricao)}</div><div class="meta small muted">${esc([`faltam ${a.restantes} de ${a.de}`, nomeCartao(a.cartao), 'última em ' + nomeMes(a.ultima.slice(0, 7)).toLowerCase()].filter(Boolean).join(' · '))}</div></div><span class="val">${brl.format(a.valor)}</span></div>`).join('');
  const recP = juntarPessoas(P.receitasPorPessoa), gasP = juntarPessoas(P.gastosPorPessoa), achar = (o, n) => Object.entries(o).find(([k]) => chaveP(k) === chaveP(n))?.[1] || 0;
  const nomes = [...new Map([...Object.keys(recP), ...Object.keys(gasP)].map(n => [chaveP(n), n])).values()];
  $('#p-pessoas').innerHTML = nomes.length ? `<table><thead><tr><th>Pessoa</th><th class="r">Receitas</th><th class="r">Gastos pagos</th></tr></thead><tbody>${nomes.map(n => `<tr><td>${esc(n)}</td><td class="r">${brl.format(achar(recP, n))}</td><td class="r">${brl.format(achar(gasP, n))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small" style="margin:0">Sem lançamentos neste mês.</p>';
}

/* ---------- ajustes ---------- */
S.aj = { aba: 'categorias', cartao: null, fixo: null };
async function renderAjustes() {
  document.querySelectorAll('[data-act="aj-aba"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.aba === S.aj.aba));
  for (const a of ['categorias', 'cartoes', 'fixos', 'visual']) $('#aj-' + a).hidden = a !== S.aj.aba;
  if (S.aj.aba === 'categorias') return desenharCategorias();
  if (S.aj.aba === 'cartoes') return desenharCartoes();
  if (S.aj.aba === 'fixos') return desenharFixos();
  if (S.aj.aba === 'visual') return desenharVisual();
}
function desenharCategorias() {
  const opts = id => CATEGORIAS.filter(c => c.id !== id).map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
  $('#aj-cats').innerHTML = CATEGORIAS.map((c, i) => `<details class="fixo-det"><summary class="fixo-row">${catDot(c.id)}<div class="body"><div class="name">${esc(c.nome)}</div><div class="meta small muted">${c.orcamento ? 'Orçamento: ' + brl.format(c.orcamento) + '/mês' : 'Sem orçamento'}</div></div>
      <span class="ordem"><button type="button" class="x" data-act="cat-mover" data-id="${c.id}" data-d="-1" aria-label="Subir" ${i ? '' : 'disabled'}>↑</button><button type="button" class="x" data-act="cat-mover" data-id="${c.id}" data-d="1" aria-label="Descer" ${i < CATEGORIAS.length - 1 ? '' : 'disabled'}>↓</button></span></summary>
    <form class="fixo-form" data-cat="${c.id}" autocomplete="off">
      <div class="row-form"><div class="field grow"><label>Nome</label><input name="nome" type="text" value="${esc(c.nome)}" maxlength="40" required></div><div class="field"><label>Cor</label><input name="cor" type="color" value="${esc(c.cor)}"></div></div>
      <div class="field"><label>Orçamento por mês (vazio = sem)</label><input name="orcamento" type="text" inputmode="decimal" value="${c.orcamento ? r2(c.orcamento).toFixed(2).replace('.', ',') : ''}" placeholder="Ex.: 800,00"></div>
      <button class="btn primary" type="submit">Salvar</button>
      ${c.id !== 'outros' ? `<div class="juntar"><div class="row-form"><div class="field grow"><label>Juntar com outra categoria</label><select name="destino">${opts(c.id)}</select></div><button class="btn" type="button" data-act="cat-juntar" data-id="${c.id}" data-confirm="Confirmar junção?">Juntar</button></div>
        <p class="muted small" style="margin:0">Todos os gastos de “${esc(c.nome)}” passam para a categoria escolhida e esta deixa de existir.</p>
        <button class="btn ghost danger" type="button" data-act="cat-excluir" data-id="${c.id}" data-confirm="Toque de novo: os gastos vão para Outros">Excluir categoria</button></div>` : '<p class="muted small" style="margin:0">“Outros” é a categoria de reserva e não pode ser excluída.</p>'}
    </form></details>`).join('');
}
function aplicarCategorias(r) { if (r.categorias) definirCategorias(r.categorias); limparCaches(); $('#m-cats').innerHTML = ''; }
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-cat]'); if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  try { aplicarCategorias(await api('categorias/' + f.dataset.cat, { method: 'PUT', body: { nome: d.nome, cor: d.cor, orcamento: d.orcamento ? parseBR(d.orcamento) : null } })); toast('Categoria salva.'); desenharCategorias(); }
  catch (err) { toast(err.message); }
});
$('#f-cat-nova').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    aplicarCategorias(await api('categorias', { method: 'POST', body: { nome: $('#cn-nome').value, cor: $('#cn-cor').value, orcamento: $('#cn-orc').value ? parseBR($('#cn-orc').value) : null } }));
    $('#cn-nome').value = ''; $('#cn-orc').value = ''; toast('Categoria criada.'); desenharCategorias();
  } catch (err) { toast(err.message); }
});
function desenharCartoes() {
  $('#aj-cards').innerHTML = S.cartoes.length ? S.cartoes.map(c => `<button class="row" data-act="ct-editar" data-id="${c.id}"><span class="cartao-ic" style="background:${esc(c.cor || '#5662C9')}"></span><span class="body"><span class="name">${esc(c.nome)}${c.final ? ` <span class="muted small">final ${esc(c.final)}</span>` : ''}</span><br><span class="meta">${esc([c.dono, c.fechamento ? 'fecha dia ' + c.fechamento : null, c.vencimento ? 'vence dia ' + c.vencimento : null].filter(Boolean).join(' · ') || 'Toque para completar')}</span></span></button>`).join('')
    : '<p class="muted small" style="margin:0">Nenhum cartão ainda. Cadastre abaixo.</p>';
  editarCartao(S.aj.cartao);
}
function editarCartao(id) {
  const c = S.cartoes.find(x => x.id === id) || null; S.aj.cartao = c?.id || null;
  $('#ct-titulo').textContent = c ? 'Editar cartão' : 'Novo cartão';
  $('#ct-nome').value = c?.nome || ''; $('#ct-final').value = c?.final || ''; $('#ct-fech').value = c?.fechamento || ''; $('#ct-venc').value = c?.vencimento || '';
  $('#ct-dono').value = c?.dono || (c ? '' : meuNome()); $('#ct-cor').value = c?.cor || '#5662C9';
  $('#ct-cancelar').hidden = !c; $('#ct-apagar').hidden = !c;
}
function aplicarCartoes(r) { S.cartoes = r.cartoes || S.cartoes; for (const px of ['m', 'n', 'mk']) $(`#${px}-pag`).innerHTML = ''; }
$('#f-cartao').addEventListener('submit', async e => {
  e.preventDefault();
  const corpo = { nome: $('#ct-nome').value, final: $('#ct-final').value, fechamento: $('#ct-fech').value || null, vencimento: $('#ct-venc').value || null, dono: $('#ct-dono').value, cor: $('#ct-cor').value };
  try { aplicarCartoes(S.aj.cartao ? await api('cartoes/' + S.aj.cartao, { method: 'PUT', body: corpo }) : await api('cartoes', { method: 'POST', body: corpo })); S.aj.cartao = null; toast('Cartão salvo.'); desenharCartoes(); }
  catch (err) { toast(err.message); }
});
async function desenharFixos() {
  $('#aj-fixos-lista').innerHTML = '<div class="spinner"></div>';
  try {
    const { fixos, mesAtual: m } = await api('fixos');
    S.aj.fixos = fixos;
    const ativos = fixos.filter(f => !f.fim || f.fim >= m), parados = fixos.filter(f => f.fim && f.fim < m);
    const tot = ativos.reduce((s, f) => s + f.total, 0);
    $('#aj-fixos-lista').innerHTML = fixos.length ? `<div class="sum"><span class="muted small">${ativos.length} ativos</span><span class="tag">${brl.format(tot)}/mês</span></div>` + [...ativos, ...parados].map(f => {
      const parado = f.fim && f.fim < m;
      return `<button class="row${parado ? ' parado' : ''}" data-act="fx-editar" data-fid="${f.fid}">${catDot(f.cat)}<span class="body"><span class="name">${esc(f.descricao)}</span><br><span class="meta">${esc([nomeCat(f.cat), 'dia ' + f.dia, f.pagamento, nomeCartao(f.cartao), parado ? 'parado' : f.fim ? 'até ' + nomeMes(f.fim).toLowerCase() : null].filter(Boolean).join(' · '))}</span></span><span class="val">${brl.format(f.total)}</span></button>`;
    }).join('') : '<p class="muted small" style="margin:0">Nenhum gasto fixo. Cadastre financiamentos, streaming e contas para o app lançar sozinho todo mês.</p>';
  } catch (e) { $('#aj-fixos-lista').innerHTML = `<p class="erro">${esc(e.message)}</p>`; }
}
function renderFixo() {
  const f = S.aj.fixo || { descricao: '', total: '', dia: Number(hoje().slice(8)), inicio: mesAtual(), fim: null, cat: 'contas', quem: meuNome(), pagamento: 'Pix' };
  S.aj.fixoCat = S.aj.fixoCat || f.cat;
  $('#fx-titulo').textContent = f.fid ? 'Gasto fixo' : 'Novo gasto fixo';
  $('#fx-desc').value = f.descricao; $('#fx-valor').value = f.total ? r2(f.total).toFixed(2).replace('.', ',') : ''; $('#fx-dia').value = f.dia;
  $('#fx-inicio').value = f.inicio; $('#fx-fim').value = f.fim || ''; $('#fx-quem').value = f.quem || '';
  $('#fx-pag').innerHTML = S.pagamentos.map(p => `<option>${esc(p)}</option>`).join(''); $('#fx-pag').value = f.pagamento || 'Pix';
  $('#fx-cartao').innerHTML = '<option value="">Não informar</option>' + S.cartoes.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join(''); $('#fx-cartao').value = f.cartao || '';
  $('#fx-cartao-wrap').hidden = !ehCartao($('#fx-pag').value) || !S.cartoes.length;
  $('#fx-apagar').hidden = !f.fid;
  $('#fx-status').hidden = !f.fid; $('#fx-status').textContent = f.fid ? 'As mudanças valem deste mês em diante. Os meses que já passaram ficam como estão. Para parar de lançar, preencha o último mês.' : '';
  desenharFixoCats();
}
function desenharFixoCats() { $('#fx-cats').innerHTML = CATEGORIAS.map(c => `<button type="button" class="chip" data-act="fx-cat" data-cat="${c.id}" aria-pressed="${S.aj.fixoCat === c.id}">${catDot(c.id)}${esc(c.nome)}</button>`).join(''); }
$('#fx-pag').addEventListener('change', () => { $('#fx-cartao-wrap').hidden = !ehCartao($('#fx-pag').value) || !S.cartoes.length; });
$('#f-fixo').addEventListener('submit', async e => {
  e.preventDefault();
  const f = S.aj.fixo;
  const corpo = { descricao: $('#fx-desc').value, total: parseBR($('#fx-valor').value), dia: +$('#fx-dia').value, inicio: $('#fx-inicio').value, fim: $('#fx-fim').value || null, cat: S.aj.fixoCat, quem: $('#fx-quem').value, pagamento: $('#fx-pag').value, cartao: ehCartao($('#fx-pag').value) ? $('#fx-cartao').value || null : null };
  try { await (f?.fid ? api('fixos/' + f.fid, { method: 'PUT', body: corpo }) : api('fixos', { method: 'POST', body: corpo })); limparCaches(); toast('Gasto fixo salvo.'); S.aj.aba = 'fixos'; ir('ajustes'); }
  catch (err) { toast(err.message); }
});
function desenharVisual() {
  $('#aj-cores').innerHTML = CORES.map(([c, , n]) => `<button class="cor" data-act="cor" data-cor="${c}" style="background:${c}" aria-pressed="${pref.cor === c}" aria-label="${n}"><span>${n}</span></button>`).join('');
  const nomes = { resumo: 'Resumo', painel: 'Painel', lancar: 'Lançar', gastos: 'Gastos', receitas: 'Receitas', mercado: 'Mercado' };
  const ordem = [...pref.abas.filter(a => ABAS.includes(a)), ...ABAS.filter(a => !pref.abas.includes(a))];
  $('#aj-abas').innerHTML = ordem.map((a, i) => `<div class="fixo-row"><div class="body"><div class="name">${i + 1}. ${nomes[a]}</div></div><span class="ordem"><button class="x" data-act="aba-mover" data-aba="${a}" data-d="-1" ${i ? '' : 'disabled'} aria-label="Mover para a esquerda">↑</button><button class="x" data-act="aba-mover" data-aba="${a}" data-d="1" ${i < ordem.length - 1 ? '' : 'disabled'} aria-label="Mover para a direita">↓</button></span></div>`).join('');
  $('#aj-inicio').value = pref.inicio;
}
$('#aj-inicio').addEventListener('change', e => { pref.inicio = e.target.value; gravarLocal('gastos:inicio', pref.inicio); toast('Pronto: o app abre nessa aba.'); });

function cliqueNovo(b, a) {
  if (a === 'rc-tipo') { S.rc.tipo = b.dataset.tipo; desenharTiposReceita(); if (!$('#rc-desc').value || S.tiposReceita.some(t => t.nome === $('#rc-desc').value)) $('#rc-desc').value = ''; if (b.dataset.tipo === 'salario' && !S.rc.editando) $('#rc-repetir').checked = true; return true; }
  if (a === 'rc-abrir') { const r = (S.receitas[S.mes] || []).find(x => x.key === b.dataset.key); if (!r) return true; if (r.previsto) { toast('Receita fixa prevista: edite em “Receitas fixas”, logo abaixo.'); return true; } prepararFormReceita(r); $('#f-receita').scrollIntoView({ behavior: 'smooth' }); return true; }
  if (a === 'rc-cancelar') { prepararFormReceita(); return true; }
  if (a === 'rc-apagar') {
    if (!confirmado(b)) return true;
    const r = S.rc.editando; if (!r) return true;
    api(`receitas/${r.key.split('/')[1]}/${r.key.split('/')[2]}`, { method: 'DELETE' }).then(() => { limparCaches(); prepararFormReceita(); toast('Receita apagada.'); renderReceitas(); }).catch(err => toast(err.message));
    return true;
  }
  if (a === 'rf-parar' || a === 'rf-reativar') {
    if (!confirmado(b)) return true;
    api('rfixos/' + b.dataset.fid, { method: 'PUT', body: a === 'rf-parar' ? { parar: true } : { reativar: true } }).then(() => { limparCaches(); toast(a === 'rf-parar' ? 'Essa receita não entra mais nos próximos meses.' : 'Receita voltou a repetir.'); renderReceitas(); }).catch(err => toast(err.message));
    return true;
  }
  if (a === 'aj-aba') { S.aj.aba = b.dataset.aba; renderAjustes(); return true; }
  if (a === 'cat-mover') {
    e_stop(b);
    const ids = CATEGORIAS.map(c => c.id), i = ids.indexOf(b.dataset.id), j = i + +b.dataset.d;
    if (j < 0 || j >= ids.length) return true;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    api('categorias/ordem', { method: 'PUT', body: { ordem: ids } }).then(r => { aplicarCategorias(r); desenharCategorias(); }).catch(err => toast(err.message));
    return true;
  }
  if (a === 'cat-juntar' || a === 'cat-excluir') {
    if (!confirmado(b)) return true;
    const id = b.dataset.id, destino = a === 'cat-juntar' ? b.closest('form').querySelector('[name=destino]').value : 'outros';
    carregando('Movendo os gastos…');
    api(a === 'cat-juntar' ? `categorias/${id}/juntar` : `categorias/${id}`, { method: a === 'cat-juntar' ? 'POST' : 'DELETE', body: { destino } })
      .then(r => { aplicarCategorias(r); toast(`Pronto: ${r.alterados} registros foram para ${nomeCat(destino)}.`); desenharCategorias(); })
      .catch(err => toast(err.message)).finally(() => carregando(null));
    return true;
  }
  if (a === 'ct-editar') { editarCartao(b.dataset.id); $('#f-cartao').scrollIntoView({ behavior: 'smooth' }); return true; }
  if (a === 'ct-cancelar') { editarCartao(null); return true; }
  if (a === 'ct-apagar') {
    if (!confirmado(b)) return true;
    api('cartoes/' + S.aj.cartao, { method: 'DELETE' }).then(r => { aplicarCartoes(r); S.aj.cartao = null; toast('Cartão removido. Os gastos antigos continuam lançados.'); desenharCartoes(); }).catch(err => toast(err.message));
    return true;
  }
  if (a === 'novo-fixo') { S.aj.fixo = null; S.aj.fixoCat = null; ir('fixo'); return true; }
  if (a === 'fx-editar') { S.aj.fixo = (S.aj.fixos || []).find(f => f.fid === b.dataset.fid) || null; S.aj.fixoCat = null; ir('fixo'); return true; }
  if (a === 'fx-cat') { S.aj.fixoCat = b.dataset.cat; desenharFixoCats(); return true; }
  if (a === 'voltar-ajustes') { S.aj.aba = 'fixos'; ir('ajustes'); return true; }
  if (a === 'fx-apagar') {
    if (!confirmado(b)) return true;
    api('fixos/' + S.aj.fixo.fid, { method: 'DELETE' }).then(() => { limparCaches(); toast('Gasto fixo excluído. Os meses passados continuam lançados.'); S.aj.aba = 'fixos'; ir('ajustes'); }).catch(err => toast(err.message));
    return true;
  }
  if (a === 'cor') { pref.cor = b.dataset.cor; gravarLocal('gastos:cor', pref.cor); aplicarAparencia(); desenharVisual(); return true; }
  if (a === 'aba-mover') {
    const ordem = [...pref.abas.filter(x => ABAS.includes(x)), ...ABAS.filter(x => !pref.abas.includes(x))], i = ordem.indexOf(b.dataset.aba), j = i + +b.dataset.d;
    if (j < 0 || j >= ordem.length) return true;
    [ordem[i], ordem[j]] = [ordem[j], ordem[i]]; pref.abas = ordem; gravarLocal('gastos:abas', ordem); aplicarAparencia(); desenharVisual();
    return true;
  }
  if (a === 'abas-padrao') { pref.abas = ABAS; gravarLocal('gastos:abas', ABAS); aplicarAparencia(); desenharVisual(); return true; }
  return false;
}
// as setas de ordem ficam dentro do <summary>: não deixam o item abrir/fechar
function e_stop(b) { b.closest('details')?.addEventListener('toggle', function v() { this.open = !this.open; this.removeEventListener('toggle', v); }, { once: true }); }

/* ---------- cliques ---------- */
function confirmado(btn) {
  if (!btn.dataset.confirm || btn.dataset.armado) return true;
  btn.dataset.armado = 1; btn.dataset.rotulo = btn.textContent; btn.textContent = btn.dataset.confirm;
  setTimeout(() => { if (btn.isConnected && btn.dataset.armado) { delete btn.dataset.armado; btn.textContent = btn.dataset.rotulo; } }, 3500);
  return false;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (cliqueNovo(b, a)) return;
  if (a === 'ir') return ir(b.dataset.v);
  if (a === 'ir-fixos') { S.aj.aba = 'fixos'; S.nota = null; return ir('ajustes'); }
  if (a === 'mes') { S.mes = somaMes(S.mes, +b.dataset.d); return render(); }
  if (a === 'filtrar') { S.filtro = b.dataset.cat || null; return S.view === 'gastos' ? renderGastos() : ir('gastos'); }
  if (a === 'abrir') { const g = Object.values(S.meses).flat().find(x => x.key === b.dataset.key); if (g) abrirNota(g, false); return; }
  if (a === 'scan') return abrirScanner();
  if (a === 'scan-sair') return fecharScanner();
  if (a === 'colar') { $('#f-link').hidden = !$('#f-link').hidden; if (!$('#f-link').hidden) $('#l-url').focus(); return; }
  if (a === 'mcat') { S.manualCat = b.dataset.cat; return renderLancar(); }
  if (a === 'ncat') { S.nota.g.cat = b.dataset.cat; marcarMudou(); document.querySelectorAll('#n-cats .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.cat === S.nota.g.cat)); return; }
  if (a === 'voltar') { S.nota = null; return ir(S.voltarPara); }
  if (a === 'salvar-nota') return salvarNota(b);
  if (a === 'apagar') { if (confirmado(b)) apagarNota(); return; }
  if (a === 'msug') {
    $('#m-desc').value = b.dataset.desc;
    if (b.dataset.fixo) $('#m-repetir').checked = true;
    $('#m-valor').focus(); return;
  }
  if (a === 'modo-convite') { $('#e-erro').hidden = true; return prepararEntrar('convite'); }
  if (a === 'modo-entrar') { $('#e-erro').hidden = true; return prepararEntrar(modoBase); }
  if (a === 'sair') { if (!confirmado(b)) return; api('sair', { method: 'POST', semSair: true }).catch(() => {}); return sair(); }
  if (a === 'remover') {
    if (!confirmado(b)) return;
    return api('usuarios/' + b.dataset.uid, { method: 'DELETE' }).then(() => { toast('Pessoa removida.'); renderConta(); }).catch(err => toast(err.message));
  }
  if (a === 'parar-fixo') {
    if (!confirmado(b)) return;
    return api('fixos/' + b.dataset.fid, { method: 'PUT', body: { parar: true } }).then(() => {
      toast('Pronto: este gasto não será mais lançado nos próximos meses.');
      limparCaches(); $('#n-fixo').innerHTML = 'Gasto fixo parado: os próximos meses não terão este lançamento.';
    }).catch(err => toast(err.message));
  }
  if (a === 'copiar-convite') {
    const texto = b.dataset.texto;
    navigator.clipboard?.writeText(texto).then(() => toast('Mensagem copiada. Cole no WhatsApp dela.'), () => toast('Não consegui copiar. Copie o código manualmente.'));
    return;
  }
});$('#qr-foto').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) lerQrDaFoto(f); });
$('#f-link').addEventListener('submit', e => { e.preventDefault(); processarQr($('#l-url').value); });

/* ---------- início ---------- */
const h = location.hash.slice(1);
ir(COM_HASH.includes(h) ? h : pref.inicio || 'resumo');
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (COM_HASH.includes(v) && v !== S.view) ir(v); });
