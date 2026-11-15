/*
 * Gastos da Casa · backend (Google Apps Script + Planilha Google)
 *
 * O site (GitHub Pages) chama: POST <link /exec>, corpo (texto) {"path","method","query","body","token"}.
 * A resposta é sempre {"status": número, "body": {...}}; erros vêm em body.erro.
 *
 * Os dados ficam na aba "dados" da planilha ligada a este script, uma linha por registro:
 *   chave | atualizado | parte1 | parte2 | ...   (o JSON do registro, dividido em partes de 45 mil caracteres)
 *
 * Chaves:
 *   g/<AAAA-MM>/<id>            um gasto (compras parceladas: <grupo>-p<n>, uma por mês)
 *   parc/<grupo>                 compra parcelada: chaves das parcelas
 *   nf/<chave44>                 índice da nota fiscal -> chave do gasto (evita lançar a mesma nota duas vezes)
 *   fixos/<fid>, fixo-pulado/<fid>/<AAAA-MM>       gastos fixos (lançados sozinhos todo mês)
 *   r/<AAAA-MM>/<id>             uma receita
 *   rfixos/<fid>, rfixo-pulado/<fid>/<AAAA-MM>     receitas fixas (salários)
 *   aprendido                    categorias escolhidas pelo casal, por código de barras e por descrição
 *   config/categorias, config/cat-alias, config/cartoes
 *   usuarios/, sessoes/, convites/, tentativas/, config/primeiro
 *   lista/, compra/atual, precos/   mercado
 *
 * Abas "Lançamentos" e "Receitas": cópia legível, gerada pelo menu Gastos da Casa > Atualizar abas de leitura.
 *
 * Propriedades do script (Configurações do projeto > Propriedades do script):
 *   ANTHROPIC_API_KEY  (opcional) liga a leitura de etiquetas por foto no Mercado.
 */

const VERSAO = '2026-11-15b';
const TZ = 'America/Campo_Grande';

/* ======================= entrada ======================= */

function doGet() {
  return saida_({ ok: true, app: 'Gastos da Casa', tipo: 'backend', versao: VERSAO });
}

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return saida_({ status: 400, body: { erro: 'Pedido inválido.' } }); }
  return saida_(atender_(req));
}

function atender_(req) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(28000); }
  catch (err) { return { status: 503, body: { erro: 'O app está ocupado. Tente de novo em alguns segundos.' } }; }
  try {
    const s = Store_.abrir();
    let res;
    try {
      res = rotas_(s, normalizarPedido_(req));
      s.salvar();
    } catch (err) {
      if (err instanceof ErroDoUsuario) { s.salvar(); res = { status: err.status, body: { erro: err.message } }; }
      else { console.error(err && err.stack ? err.stack : err); res = { status: 500, body: { erro: 'Erro inesperado. Tente de novo.' } }; }
    }
    return res;
  } finally { lock.releaseLock(); }
}

function saida_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function normalizarPedido_(req) {
  req = req || {};
  const path = String(req.path || '').replace(/^\/+|\/+$/g, '');
  return {
    method: String(req.method || 'GET').toUpperCase(),
    partes: path ? path.split('/').filter(String) : [],
    query: req.query && typeof req.query === 'object' ? req.query : {},
    body: req.body && typeof req.body === 'object' ? req.body : {},
    token: String(req.token || ''),
  };
}

class ErroDoUsuario extends Error {
  constructor(msg, status) { super(msg); this.status = status || 400; }
}
const ok_ = (body, status) => ({ status: status || 200, body: body });

/* ======================= armazenamento ======================= */

const ABA_DADOS = 'dados', TAM_PARTE = 45000;

const Store_ = {
  abrir() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let aba = ss.getSheetByName(ABA_DADOS);
    if (!aba) {
      aba = ss.insertSheet(ABA_DADOS);
      aba.getRange(1, 1, 1, 3).setValues([['chave', 'atualizado', 'dados']]);
      aba.setFrozenRows(1);
      aba.getRange('A:Z').setNumberFormat('@');
    }
    const dados = {}, quando = {};
    const n = aba.getLastRow();
    if (n > 1) {
      const vals = aba.getRange(2, 1, n - 1, aba.getLastColumn()).getValues();
      for (const linha of vals) {
        const k = String(linha[0] || '');
        if (!k) continue;
        let txt = '';
        for (let i = 2; i < linha.length; i++) txt += linha[i] === '' || linha[i] == null ? '' : String(linha[i]);
        dados[k] = txt; quando[k] = String(linha[1] || '');
      }
    }
    return new Loja_(aba, dados, quando);
  },
};

class Loja_ {
  constructor(aba, dados, quando) { this.aba = aba; this.dados = dados; this.quando = quando; this.sujo = false; }
  get(k) {
    const t = this.dados[k];
    if (t === undefined || t === '') return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }
  has(k) { return this.dados[k] !== undefined; }
  set(k, v) { this.dados[k] = JSON.stringify(v); this.quando[k] = new Date().toISOString(); this.sujo = true; }
  setSeNovo(k, v) { if (this.has(k)) return false; this.set(k, v); return true; }
  del(k) { if (this.dados[k] !== undefined) { delete this.dados[k]; delete this.quando[k]; this.sujo = true; } }
  chaves(prefixo) { return Object.keys(this.dados).filter(k => k.indexOf(prefixo) === 0).sort(); }
  todos(prefixo) { return this.chaves(prefixo).map(k => this.get(k)).filter(Boolean); }
  salvar() {
    if (!this.sujo) return;
    const chaves = Object.keys(this.dados).sort();
    let maxPartes = 1;
    const linhas = chaves.map(k => {
      const t = this.dados[k], partes = [];
      for (let i = 0; i < t.length; i += TAM_PARTE) partes.push(t.slice(i, i + TAM_PARTE));
      if (!partes.length) partes.push('');
      maxPartes = Math.max(maxPartes, partes.length);
      return [k, this.quando[k] || ''].concat(partes);
    });
    const largura = 2 + maxPartes;
    linhas.forEach(l => { while (l.length < largura) l.push(''); });
    const aba = this.aba;
    const ultima = Math.max(aba.getLastRow(), 1), colunas = Math.max(aba.getLastColumn(), largura);
    if (ultima > 1) aba.getRange(2, 1, ultima - 1, colunas).clearContent();
    const cab = ['chave', 'atualizado'];
    for (let i = 1; i <= maxPartes; i++) cab.push(maxPartes === 1 ? 'dados' : 'dados ' + i);
    aba.getRange(1, 1, 1, largura).setValues([cab]);
    if (linhas.length) {
      const r = aba.getRange(2, 1, linhas.length, largura);
      r.setNumberFormat('@');
      r.setValues(linhas);
    }
    this.sujo = false;
  }
}

/* ======================= utilidades ======================= */

const r2 = n => Math.round(n * 100) / 100;
const novoId_ = n => (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, n || 12);
const agora_ = () => new Date().toISOString();
const hojeISO_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
const mesHoje_ = () => hojeISO_().slice(0, 7);
const mesDe_ = data => String(data).slice(0, 7);
const ehMes_ = m => /^\d{4}-\d{2}$/.test(String(m || ''));
const ehData_ = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
function somaMes_(mes, d) {
  const y = Number(mes.slice(0, 4)), m = Number(mes.slice(5, 7)) - 1 + d;
  const t = new Date(Date.UTC(y, m, 1));
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0');
}
function diasNoMes_(mes) { return new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate(); }
const dataNoMes_ = (mes, dia) => mes + '-' + String(Math.max(1, Math.min(Number(dia) || 1, diasNoMes_(mes)))).padStart(2, '0');
const texto_ = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const semAcento_ = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const slug_ = s => semAcento_(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'item';
const normDesc_ = s => semAcento_(String(s || '').toUpperCase()).replace(/[^A-Z0-9]+/g, ' ').trim();
const porData_ = (a, b) => (b.data + (b.hora || '')).localeCompare(a.data + (a.hora || ''));
function comNumero_(v) { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/\./g, '').replace(',', '.')); return isFinite(n) ? n : NaN; }
function valorPositivo_(v) {
  const n = typeof v === 'number' ? v : comNumero_(v);
  const t = r2(n);
  if (!(t > 0)) throw new ErroDoUsuario('Informe um valor maior que zero.');
  return t;
}

/* ======================= categorias ======================= */

const CATEGORIAS_PADRAO = [
  ['mercado', 'Alimentação', '#2E8B57'], ['bebidas', 'Bebidas', '#2F7FD1'], ['alcool', 'Bebidas alcoólicas', '#8E44AD'],
  ['limpeza', 'Limpeza', '#16A3A3'], ['higiene', 'Higiene e beleza', '#D2569B'], ['casa', 'Utilidades do lar', '#A0763C'],
  ['pet', 'Pet', '#C9822B'], ['farmacia', 'Farmácia e saúde', '#D64541'], ['habitacao', 'Habitação', '#1F4E79'],
  ['contas', 'Contas da casa', '#3F6E8C'], ['combustivel', 'Combustível', '#E8A317'], ['manutencao', 'Manutenção do carro', '#6B5B95'],
  ['financiamento_carro', 'Financiamento do carro', '#34495E'], ['transporte', 'Transporte e apps', '#5662C9'],
  ['assinaturas', 'Streaming e assinaturas', '#E50914'], ['compras_online', 'Compras online', '#EE4D2D'],
  ['restaurante', 'Restaurantes e delivery', '#E0662B'], ['lazer', 'Lazer', '#C4A11E'], ['vestuario', 'Vestuário', '#9C5D7A'],
  ['educacao', 'Educação', '#4C9A2A'], ['outros', 'Outros', '#7D8791'],
].map(c => ({ id: c[0], nome: c[1], cor: c[2], orcamento: null }));

function categorias_(s) { return s.get('config/categorias') || CATEGORIAS_PADRAO.map(c => Object.assign({}, c)); }
function mapaCat_(s) { const m = {}; categorias_(s).forEach(c => { m[c.id] = c; }); return m; }
function aliasCat_(s) { return s.get('config/cat-alias') || {}; }
// Categoria válida: segue as junções (alias) e, se não existir mais, cai em "Outros".
function resolverCat_(s, id, padrao) {
  const mapa = mapaCat_(s), alias = aliasCat_(s);
  let x = id;
  for (let i = 0; i < 6 && x && !mapa[x] && alias[x]; i++) x = alias[x];
  if (x && mapa[x]) return x;
  return padrao === undefined ? 'outros' : padrao;
}

// Descrições de NFC-e vêm abreviadas ("D A AXE 200ML", "ST ALBANY 80G", "LAV LOU MINUAN").
// A ordem importa: limpeza antes de bebidas por causa de "AGUA SANITARIA".
const REGRAS = [
  ['combustivel', /\b(GASOLINA|ETANOL|DIESEL|GNV|ALCOOL COMUM|ALCOOL HIDRAT|ETANOL HIDRAT|ARLA)\b/],
  ['manutencao', /\b(OLEO MOTOR|OLEO LUBR|LUBRIFICANTE|5W30|5W40|10W40|15W40|FLUIDO FREIO|FLUIDO ARREF|ADITIVO RADIADOR|PALHETA|PNEU|PASTILHA|FILTRO OLEO|FILTRO AR|FILTRO COMB|LAVAGEM|DUCHA)\b/],
  ['alcool', /\b(CERV|CERVEJA|CHOPP|VINHO|VODKA|WHISKY|WHISKEY|GIN|CACHACA|ESPUMANTE|LICOR|RUM|TEQUILA|SAKE|APERITIVO)\b/],
  ['limpeza', /\b(LAV|LAVA|DET|DETERG|DETERGENTE|AMAC|AMACIANTE|DESINF|DESINFETANTE|SANIT|SANITARIA|ALVEJ|ALVEJANTE|SAPOLIO|ESPONJA|ESPONJ|TOALHA|SACO LIXO|SACO DE LIXO|SACOS DE LIXO|SC LIXO|LIMP|LIMPADOR|MULTIUSO|PINHO|CLORO|ODORIZ|ODORIZADOR|INSET|INSETICIDA|LUSTRA|ESFREG|PANO|TIRA MANCHA|SABAO PO|SAB PO|SABAO BARRA|VASSOURA|RODO)\b/],
  ['higiene', /^(ST|SAB|SABON|SH|SHAMP|COND|CD|ED|D A|DS|DES|DESOD|PH|AP|ABS|HID|ENX)\b/],
  ['higiene', /\b(SABONETE|SHAMPOO|CONDICIONADOR|CREME DENT|CR DENT|DENTAL|ESCOVA|DESODORANTE|PAP HIG|HIGIENICO|ABSORV|ABSORVENTE|FRALDA|FRALD|COTONETE|HASTES|FIO DENT|ENXAG|ENXAGUANTE|PROTETOR SOLAR|HIDRATANTE|BARBEAR|APAR|LENCO UMED|LEN UMED|ESMALTE|ACETONA|TINTURA|GEL CAB)\b/],
  ['casa', /\b(FILME PVC|PVC|PAPEL ALUM|PAP ALUM|ALUMINIO|FILTR|FILTRO|PILHA|PILHAS|LAMP|LAMPADA|VELA|COPO DESC|PRATO DESC|DESCART|FOSFORO|ISQUEIRO|PRENDEDOR|GUARDANAPO|GUARD|SACO FREEZER|SACO ZIP|CARVAO)\b/],
  ['pet', /\b(RACAO|RAC|PETSHOP|PET SHOP|AREIA GATO|AREIA SANIT|PETISCO|WHISKAS|PEDIGREE|GOLDEN|PREMIER|FRISKIES|DOG CHOW|CAT CHOW|BIFINHO)\b/],
  ['farmacia', /\b(DIPIRONA|PARACETAMOL|DORFLEX|NEOSALDINA|TYLENOL|IBUPROFENO|BAND AID|CURATIVO|ALCOOL 70|ALC 70|SORO FISIOL|VITAMINA|TERMOMETRO|GAZE|ESPARADRAPO)\b/],
  ['bebidas', /\b(BEB|REFRIG|REFRI|SUCO|NECTAR|AGUA|ENERG|ENERGETICO|ISOTON|ISOTONICO|GATORADE|CHA|COCA|GUARANA|H2OH|PURO COCO|TONICA|KOMBUCHA)\b/],
];

function aprendido_(s) { return s.get('aprendido') || { porCodigo: {}, porDescricao: {} }; }

function categorizar_(s, desc, cod, ap) {
  const d = normDesc_(desc), mapa = mapaCat_(s);
  ap = ap || aprendido_(s);
  const pc = cod && ap.porCodigo[cod] ? resolverCat_(s, ap.porCodigo[cod], null) : null;
  if (pc) return { cat: pc, fonte: 'aprendido' };
  const pd = ap.porDescricao[d] ? resolverCat_(s, ap.porDescricao[d], null) : null;
  if (pd) return { cat: pd, fonte: 'aprendido' };
  for (const r of REGRAS) if (r[1].test(d)) { const c = resolverCat_(s, r[0], null); if (c) return { cat: c, fonte: 'regra' }; }
  // num supermercado, o que não casou com nenhuma regra quase sempre é comida
  return { cat: mapa.mercado ? 'mercado' : 'outros', fonte: 'padrao' };
}

// Guarda as categorias que o casal escolheu, para a próxima nota já vir certa.
function aprender_(s, itens) {
  const ap = aprendido_(s), mapa = mapaCat_(s);
  let mudou = false;
  (itens || []).forEach(i => {
    if (!mapa[i.cat]) return;
    if (i.cod && ap.porCodigo[i.cod] !== i.cat) { ap.porCodigo[i.cod] = i.cat; mudou = true; }
    const d = normDesc_(i.d);
    if (d && ap.porDescricao[d] !== i.cat) { ap.porDescricao[d] = i.cat; mudou = true; }
  });
  if (mudou) s.set('aprendido', ap);
}

const COR_OK = /^#[0-9a-fA-F]{6}$/;
function orcamento_(v) {
  if (v === null || v === '' || v === undefined) return null;
  const n = r2(comNumero_(v));
  return n > 0 ? n : null;
}

function criarCategoria_(s, b) {
  const nome = texto_(b.nome, 40);
  if (nome.length < 2) throw new ErroDoUsuario('Dê um nome à categoria.');
  const lista = categorias_(s);
  if (lista.some(c => slug_(c.nome) === slug_(nome))) throw new ErroDoUsuario('Já existe uma categoria com esse nome.', 409);
  let id = slug_(nome).replace(/-/g, '_').slice(0, 30), base = id, n = 2;
  const alias = aliasCat_(s);
  while (lista.some(c => c.id === id) || alias[id]) id = base + '_' + (n++);
  const c = { id: id, nome: nome, cor: COR_OK.test(b.cor || '') ? b.cor : '#7D8791', orcamento: orcamento_(b.orcamento) };
  const iOutros = lista.findIndex(x => x.id === 'outros');
  if (iOutros >= 0) lista.splice(iOutros, 0, c); else lista.push(c);
  s.set('config/categorias', lista);
  return c;
}

function alterarCategoria_(s, id, b) {
  const lista = categorias_(s), c = lista.find(x => x.id === id);
  if (!c) throw new ErroDoUsuario('Categoria não encontrada.', 404);
  if (b.nome != null) {
    const nome = texto_(b.nome, 40);
    if (nome.length < 2) throw new ErroDoUsuario('Dê um nome à categoria.');
    if (lista.some(x => x.id !== id && slug_(x.nome) === slug_(nome))) throw new ErroDoUsuario('Já existe uma categoria com esse nome.', 409);
    c.nome = nome;
  }
  if (b.cor != null) { if (!COR_OK.test(b.cor)) throw new ErroDoUsuario('Cor inválida.'); c.cor = b.cor; }
  if (b.orcamento !== undefined) c.orcamento = orcamento_(b.orcamento);
  s.set('config/categorias', lista);
  return c;
}

function ordenarCategorias_(s, ordem) {
  const lista = categorias_(s);
  if (!Array.isArray(ordem)) throw new ErroDoUsuario('Ordem inválida.');
  const pos = {}; ordem.forEach((id, i) => { pos[id] = i; });
  lista.sort((a, b) => (pos[a.id] == null ? 999 : pos[a.id]) - (pos[b.id] == null ? 999 : pos[b.id]));
  s.set('config/categorias', lista);
  return lista;
}

// Junta a categoria "origem" em "destino": todos os gastos, itens, fixos, lista e preços passam para o destino.
function juntarCategoria_(s, origem, destino) {
  const lista = categorias_(s);
  if (origem === destino) throw new ErroDoUsuario('Escolha outra categoria para juntar.');
  if (origem === 'outros') throw new ErroDoUsuario('"Outros" não pode ser removida.');
  if (!lista.some(c => c.id === origem)) throw new ErroDoUsuario('Categoria não encontrada.', 404);
  if (!lista.some(c => c.id === destino)) throw new ErroDoUsuario('Categoria de destino não encontrada.', 404);
  let alterados = 0;
  const troca = obj => {
    let mudou = false;
    if (obj.cat === origem) { obj.cat = destino; mudou = true; }
    if (Array.isArray(obj.itens)) obj.itens.forEach(i => { if (i.cat === origem) { i.cat = destino; mudou = true; } });
    return mudou;
  };
  ['g/', 'fixos/', 'lista/', 'precos/', 'compra/'].forEach(p => s.chaves(p).forEach(k => {
    const v = s.get(k); if (v && troca(v)) { s.set(k, v); alterados++; }
  }));
  const ap = aprendido_(s); let mudouAp = false;
  ['porCodigo', 'porDescricao'].forEach(t => Object.keys(ap[t]).forEach(k => { if (ap[t][k] === origem) { ap[t][k] = destino; mudouAp = true; } }));
  if (mudouAp) s.set('aprendido', ap);
  const alias = aliasCat_(s);
  Object.keys(alias).forEach(k => { if (alias[k] === origem) alias[k] = destino; });
  alias[origem] = destino;
  s.set('config/cat-alias', alias);
  s.set('config/categorias', lista.filter(c => c.id !== origem));
  return { alterados: alterados };
}

/* ======================= cartões ======================= */

function cartoes_(s) { return s.get('config/cartoes') || []; }
function limparCartao_(b, atual) {
  const c = Object.assign({}, atual || {});
  if (b.nome != null || !atual) { c.nome = texto_(b.nome, 30); if (c.nome.length < 2) throw new ErroDoUsuario('Dê um nome ao cartão, ex.: Nubank.'); }
  if (b.final !== undefined) c.final = String(b.final || '').replace(/\D/g, '').slice(-4) || null;
  if (b.fechamento !== undefined) { const f = Number(b.fechamento); c.fechamento = f >= 1 && f <= 31 ? Math.round(f) : null; }
  if (b.vencimento !== undefined) { const v = Number(b.vencimento); c.vencimento = v >= 1 && v <= 31 ? Math.round(v) : null; }
  if (b.cor !== undefined) c.cor = COR_OK.test(b.cor || '') ? b.cor : '#5662C9';
  if (b.dono !== undefined) c.dono = texto_(b.dono, 40) || null;
  return c;
}

/* ======================= contas (pessoas da casa) ======================= */

const SESSAO_DIAS = 180, CONVITE_DIAS = 7, LIMITE_ERROS = 8, ESPERA_MS = 15 * 6e4;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I, que se confundem ao ditar

const chaveNome_ = nome => semAcento_(String(nome || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
function segredo_() {
  const p = PropertiesService.getScriptProperties();
  let k = p.getProperty('SEGREDO');
  if (!k) { k = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SEGREDO', k); }
  return k;
}
function hash_(senha, sal) {
  const chave = Utilities.newBlob(segredo_() + ':' + sal).getBytes();
  let h = Utilities.computeHmacSha256Signature(Utilities.newBlob(String(senha)).getBytes(), chave);
  for (let i = 1; i < 800; i++) h = Utilities.computeHmacSha256Signature(h, chave);
  return Utilities.base64Encode(h);
}
function iguais_(a, b) { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.min(a.length, b.length); i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function novoSegredo_(senha) { const sal = novoId_(32); return { sal: sal, hash: hash_(senha, sal) }; }
const confere_ = (senha, u) => iguais_(hash_(senha, u.sal), u.hash);

function validarNome_(nome) {
  nome = String(nome || '').trim().replace(/\s+/g, ' ');
  if (nome.length < 2 || nome.length > 30) throw new ErroDoUsuario('Informe um nome entre 2 e 30 letras.');
  return nome;
}
function validarSenha_(senha) {
  if (typeof senha !== 'string' || senha.length < 6 || senha.length > 100) throw new ErroDoUsuario('A senha precisa ter pelo menos 6 caracteres.');
  return senha;
}
const usuarios_ = s => s.todos('usuarios/');
const publico_ = u => ({ uid: u.uid, nome: u.nome, admin: !!u.admin });

function abrirSessao_(s, u) {
  const token = novoId_(48);
  s.set('sessoes/' + token, { uid: u.uid, criadoEm: agora_() });
  return { token: token, usuario: publico_(u) };
}
function gravarUsuario_(s, nome, segredo, admin) {
  if (usuarios_(s).some(u => u.chaveNome === chaveNome_(nome))) throw new ErroDoUsuario('Já existe uma pessoa com esse nome. Use outro nome.', 409);
  const u = Object.assign({ uid: novoId_(16), nome: nome, chaveNome: chaveNome_(nome) }, segredo, { admin: admin, criadoEm: agora_() });
  s.set('usuarios/' + u.uid, u);
  return u;
}
function estadoContas_(s) { return { temUsuarios: s.chaves('usuarios/').length > 0, senhaAntiga: false }; }

function criarConta_(s, b) {
  const nome = validarNome_(b.nome); validarSenha_(b.senha);
  if (s.chaves('usuarios/').length || !s.setSeNovo('config/primeiro', { em: agora_() })) throw new ErroDoUsuario('A primeira conta já foi criada. Use "Entrar".', 409);
  return abrirSessao_(s, gravarUsuario_(s, nome, novoSegredo_(b.senha), true));
}

const chaveTent_ = nome => 'tentativas/' + (chaveNome_(nome).replace(/ /g, '-') || 'x');
function entrar_(s, b) {
  const nome = validarNome_(b.nome);
  if (typeof b.senha !== 'string' || !b.senha) throw new ErroDoUsuario('Informe a senha.');
  const t = s.get(chaveTent_(nome));
  if (t && t.n >= LIMITE_ERROS && Date.now() - t.ultima < ESPERA_MS) throw new ErroDoUsuario('Muitas tentativas erradas. Espere 15 minutos e tente de novo.', 429);
  const usuarios = usuarios_(s);
  if (!usuarios.length) throw new ErroDoUsuario('Ainda não há contas. Crie a primeira.', 409);
  const u = usuarios.find(x => x.chaveNome === chaveNome_(nome));
  if (!u || !confere_(b.senha, u)) {
    const n = t && Date.now() - t.ultima < ESPERA_MS ? t.n + 1 : 1;
    s.set(chaveTent_(nome), { n: n, ultima: Date.now() });
    throw new ErroDoUsuario('Nome ou senha incorretos.', 401);
  }
  s.del(chaveTent_(nome));
  return abrirSessao_(s, u);
}

function aceitarConvite_(s, b) {
  validarSenha_(b.senha);
  const codigo = String(b.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = codigo.length === 8 ? s.get('convites/' + codigo) : null;
  if (!c || Date.parse(c.expira) < Date.now()) throw new ErroDoUsuario('Convite inválido ou vencido. Peça um novo.', 404);
  const u = gravarUsuario_(s, c.nome, novoSegredo_(b.senha), false);
  s.del('convites/' + codigo);
  return abrirSessao_(s, u);
}

function usuarioDaSessao_(s, token) {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const sess = s.get('sessoes/' + token);
  if (!sess) return null;
  if (Date.now() - Date.parse(sess.criadoEm) > SESSAO_DIAS * 864e5) { s.del('sessoes/' + token); return null; }
  const u = s.get('usuarios/' + sess.uid);
  return u ? Object.assign({}, u, { token: token }) : null;
}

function criarConvite_(s, eu, b) {
  if (!eu.admin) throw new ErroDoUsuario('Só quem criou a casa pode convidar pessoas.', 403);
  const nome = validarNome_(b.nome);
  if (usuarios_(s).some(x => x.chaveNome === chaveNome_(nome))) throw new ErroDoUsuario('Já existe uma pessoa com esse nome.', 409);
  let codigo = '';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  for (let i = 0; i < 8; i++) codigo += ALFABETO[(bytes[i] + 256) % ALFABETO.length];
  const expira = new Date(Date.now() + CONVITE_DIAS * 864e5).toISOString();
  s.set('convites/' + codigo, { nome: nome, criadoPor: eu.uid, expira: expira });
  return { codigo: codigo, nome: nome, expira: expira };
}

function trocarSenha_(s, eu, b) {
  validarSenha_(b.nova);
  if (!confere_(String(b.atual || ''), eu)) throw new ErroDoUsuario('A senha atual está incorreta.', 401);
  const u = s.get('usuarios/' + eu.uid);
  s.set('usuarios/' + eu.uid, Object.assign(u, novoSegredo_(b.nova)));
}

function removerUsuario_(s, eu, uid) {
  if (!eu.admin) throw new ErroDoUsuario('Só quem criou a casa pode remover pessoas.', 403);
  if (uid === eu.uid) throw new ErroDoUsuario('Você não pode remover a si mesmo.');
  s.del('usuarios/' + uid);
  s.chaves('sessoes/').forEach(k => { const x = s.get(k); if (x && x.uid === uid) s.del(k); });
}

/* ======================= gastos ======================= */

const PAGAMENTOS = ['Pix', 'Cartão de Crédito', 'Cartão de Débito', 'Dinheiro', 'Boleto', 'Débito automático', 'Vale-alimentação', 'Transferência'];
const ehCredito_ = p => /cr[eé]dito/i.test(String(p || ''));

function limparGasto_(s, g, quem) {
  const mapa = mapaCat_(s);
  const catOk = c => (mapa[c] ? c : resolverCat_(s, c, 'outros'));
  const itens = Array.isArray(g.itens) && g.itens.length ? g.itens.slice(0, 400).map(i => ({
    d: texto_(i.d, 120), cod: i.cod ? texto_(i.cod, 14) : null,
    q: Number(i.q) || 1, un: texto_(i.un || 'UN', 6) || 'UN', vu: i.vu == null ? null : Number(i.vu),
    vt: r2(Number(i.vt) || 0), cat: catOk(i.cat),
  })) : null;
  const total = valorPositivo_(g.total);
  if (!ehData_(g.data)) throw new ErroDoUsuario('Informe a data no formato AAAA-MM-DD.');
  const pagamento = g.pagamento ? texto_(g.pagamento, 40) : null;
  const cartoes = cartoes_(s);
  const cartao = g.cartao && cartoes.some(c => c.id === g.cartao) ? g.cartao : null;
  let parcelas = Math.round(Number(g.parcelas) || 1);
  if (!ehCredito_(pagamento) || parcelas < 1) parcelas = 1;
  if (parcelas > 48) throw new ErroDoUsuario('O máximo é 48 parcelas.');
  return {
    data: g.data, hora: g.hora || null,
    descricao: texto_(g.descricao || g.loja || 'Gasto', 120) || 'Gasto',
    loja: g.loja ? texto_(g.loja, 120) : null,
    quem: texto_(g.quem || quem || '', 40),
    pagamento: pagamento,
    cartao: ehCredito_(pagamento) || /d[eé]bito/i.test(pagamento || '') ? cartao : null,
    parcelas: parcelas,
    cat: itens ? null : catOk(g.cat || 'outros'),
    total: total, bruto: g.bruto != null ? r2(Number(g.bruto)) : null, desconto: g.desconto != null ? r2(Number(g.desconto)) || 0 : 0,
    itens: itens, origem: ['nfce', 'fixo', 'mercado'].indexOf(g.origem) >= 0 ? g.origem : 'manual',
    chave: g.chave && /^\d{44}$/.test(g.chave) ? g.chave : null,
    nota: g.nota ? texto_(g.nota, 300) : null,
  };
}

// Mês da 1ª parcela: o mês da compra, ou o seguinte se a compra caiu depois do fechamento da fatura.
function mesPrimeiraParcela_(s, g) {
  let mes = mesDe_(g.data);
  const c = g.cartao ? cartoes_(s).find(x => x.id === g.cartao) : null;
  if (c && c.fechamento && Number(g.data.slice(8, 10)) >= c.fechamento) mes = somaMes_(mes, 1);
  return mes;
}

// Grava uma compra: à vista vira um gasto; parcelada vira uma parcela em cada mês. Devolve os documentos gravados.
function gravarCompra_(s, eu, g, extra) {
  extra = extra || {};
  const id = extra.id || novoId_(12);
  const base = Object.assign({}, g, { criadoPor: extra.criadoPor || eu.nome, criadoEm: extra.criadoEm || agora_() });
  if (extra.editado) { base.editadoPor = eu.nome; base.editadoEm = agora_(); }
  delete base.parcelas;
  if (g.parcelas <= 1) {
    const key = 'g/' + mesDe_(g.data) + '/' + id;
    const doc = Object.assign(base, { id: id, key: key, parcela: null });
    s.set(key, doc);
    return [doc];
  }
  const n = g.parcelas, valor = Math.floor(g.total * 100 / n) / 100, ultimo = r2(g.total - valor * (n - 1));
  const mes1 = mesPrimeiraParcela_(s, g), dia = Number(g.data.slice(8, 10));
  const docs = [];
  for (let k = 1; k <= n; k++) {
    const mes = somaMes_(mes1, k - 1), pid = id + '-p' + k, key = 'g/' + mes + '/' + pid;
    const doc = Object.assign({}, base, {
      id: pid, key: key, data: dataNoMes_(mes, dia), dataCompra: g.data,
      total: k === n ? ultimo : valor,
      parcela: { n: k, de: n, grupo: id, totalCompra: g.total, valor: valor },
    });
    s.set(key, doc);
    docs.push(doc);
  }
  s.set('parc/' + id, { grupo: id, keys: docs.map(d => d.key), total: g.total, parcelas: n, data: g.data, descricao: g.descricao });
  return docs;
}

// Chaves de todos os gastos de uma compra (as parcelas, se for parcelada).
function chavesDaCompra_(s, doc) {
  if (doc.parcela && doc.parcela.grupo) {
    const p = s.get('parc/' + doc.parcela.grupo);
    if (p) return p.keys.slice();
    return s.chaves('g/').filter(k => k.split('/')[2].indexOf(doc.parcela.grupo + '-p') === 0);
  }
  return [doc.key];
}
function removerCompra_(s, doc) {
  const keys = chavesDaCompra_(s, doc);
  keys.forEach(k => s.del(k));
  if (doc.parcela && doc.parcela.grupo) s.del('parc/' + doc.parcela.grupo);
  if (doc.chave && s.get('nf/' + doc.chave) && keys.indexOf(s.get('nf/' + doc.chave)) >= 0) s.del('nf/' + doc.chave);
  return keys;
}

// A compra completa por trás de uma parcela (valor total e data da compra).
function compraDe_(doc) {
  if (!doc.parcela) return Object.assign({}, doc, { parcelas: 1 });
  return Object.assign({}, doc, { total: doc.parcela.totalCompra, data: doc.dataCompra || doc.data, parcelas: doc.parcela.de });
}

function registrarPrecosDaNota_(s, g) {
  if (!g.itens || g.origem !== 'nfce') return;
  registrarPrecos_(s, g.itens.map(i => ({
    nome: i.d, preco: i.vu != null ? i.vu : r2(i.vt / (i.q || 1)), qtd: i.q,
    un: /^KG$/i.test(i.un) ? 'kg' : /^L$/i.test(i.un) ? 'L' : 'un', cat: i.cat,
  })), { data: g.data, loja: g.descricao, origem: 'nfce' });
}

function novoGasto_(s, eu, body) {
  const g = limparGasto_(s, body, eu.nome);
  if (body.repetir && !g.itens) {
    // gasto fixo: cadastra o modelo e lança o mês do gasto
    const f = novoFixo_(s, eu, { descricao: g.descricao, cat: g.cat, total: g.total, dia: Number(g.data.slice(8)), quem: g.quem, pagamento: g.pagamento, cartao: g.cartao, inicio: mesDe_(g.data) });
    const doc = lancamentoFixo_(f, mesDe_(g.data));
    s.set(doc.key, doc);
    return { gasto: doc, gastos: [doc] };
  }
  if (g.chave && s.get('nf/' + g.chave)) throw new ErroDoUsuario('Essa nota já foi lançada.', 409);
  const docs = gravarCompra_(s, eu, g);
  if (g.chave) s.set('nf/' + g.chave, docs[0].key);
  if (g.itens) aprender_(s, g.itens);
  registrarPrecosDaNota_(s, g);
  // a nota confirma uma compra registrada pelo app de mercado: a versão das etiquetas sai
  if (body.substitui && /^g\/\d{4}-\d{2}\/[\w-]+$/.test(body.substitui)) {
    const velho = s.get(body.substitui);
    if (velho && velho.origem === 'mercado') s.del(body.substitui);
  }
  return { gasto: docs[0], gastos: docs };
}

function editarGasto_(s, eu, key, body) {
  const atual = s.get(key);
  if (!atual) throw new ErroDoUsuario('Lançamento não encontrado.', 404);
  const mes = key.split('/')[1];
  if (atual.origem === 'fixo' && atual.fixoId) {
    // o lançamento de um gasto fixo: muda só este mês
    const g = limparGasto_(s, Object.assign({}, atual, body, { parcelas: 1 }), atual.quem);
    const novoKey = 'g/' + mesDe_(g.data) + '/' + atual.id;
    delete g.parcelas;
    const doc = Object.assign({}, atual, g, { key: novoKey, editadoPor: eu.nome, editadoEm: agora_() });
    s.set(novoKey, doc);
    if (novoKey !== key) { s.del(key); s.set('fixo-pulado/' + atual.fixoId + '/' + mes, '1'); }
    return { gasto: doc, gastos: [doc], removidos: novoKey !== key ? [key] : [] };
  }
  const g = limparGasto_(s, Object.assign({}, compraDe_(atual), body), atual.quem);
  const removidos = removerCompra_(s, atual);
  const id = atual.parcela ? atual.parcela.grupo : atual.id;
  const docs = gravarCompra_(s, eu, g, { id: id, criadoPor: atual.criadoPor, criadoEm: atual.criadoEm, editado: true });
  if (g.chave) s.set('nf/' + g.chave, docs[0].key);
  if (g.itens) aprender_(s, g.itens);
  return { gasto: docs[0], gastos: docs, removidos: removidos.filter(k => !docs.some(d => d.key === k)) };
}

function apagarGasto_(s, key) {
  const atual = s.get(key);
  if (!atual) throw new ErroDoUsuario('Lançamento não encontrado.', 404);
  if (atual.fixoId) { s.del(key); s.set('fixo-pulado/' + atual.fixoId + '/' + key.split('/')[1], '1'); return { ok: true, removidos: [key] }; }
  return { ok: true, removidos: removerCompra_(s, atual) };
}

/* ---------- gastos fixos ---------- */

function lancamentoFixo_(f, mes) {
  const id = 'fixo-' + f.fid;
  return {
    id: id, key: 'g/' + mes + '/' + id, data: dataNoMes_(mes, f.dia), hora: null,
    descricao: f.descricao, loja: null, quem: f.quem, pagamento: f.pagamento || null, cartao: f.cartao || null,
    cat: f.cat, total: f.total, bruto: null, desconto: 0, itens: null, chave: null, nota: null, parcela: null,
    origem: 'fixo', fixoId: f.fid, criadoPor: f.quem, criadoEm: agora_(),
  };
}

function limparFixo_(s, b, atual) {
  const f = Object.assign({}, atual || {});
  if (b.descricao != null || !atual) { f.descricao = texto_(b.descricao, 120); if (!f.descricao) throw new ErroDoUsuario('Informe a descrição.'); }
  if (b.cat != null || !atual) f.cat = resolverCat_(s, b.cat || 'outros');
  if (b.total != null || !atual) f.total = valorPositivo_(b.total);
  if (b.dia != null || !atual) { const d = Math.round(Number(b.dia)); if (!(d >= 1 && d <= 31)) throw new ErroDoUsuario('O dia do lançamento vai de 1 a 31.'); f.dia = d; }
  if (b.quem != null) f.quem = texto_(b.quem, 40);
  if (b.pagamento !== undefined) f.pagamento = b.pagamento ? texto_(b.pagamento, 40) : null;
  if (b.cartao !== undefined) f.cartao = b.cartao && cartoes_(s).some(c => c.id === b.cartao) ? b.cartao : null;
  if (b.inicio !== undefined || !atual) f.inicio = ehMes_(b.inicio) ? b.inicio : mesHoje_();
  if (b.fim !== undefined) f.fim = ehMes_(b.fim) ? b.fim : null;
  if (b.parar) f.fim = ehMes_(b.fim) ? b.fim : mesHoje_();
  if (b.reativar) f.fim = null;
  if (f.fim && f.fim < f.inicio) throw new ErroDoUsuario('O último mês não pode ser antes do primeiro.');
  return f;
}

function novoFixo_(s, eu, b) {
  const f = limparFixo_(s, b, null);
  f.fid = novoId_(12); f.quem = f.quem || eu.nome; f.fim = f.fim || null; f.criadoPor = eu.nome; f.criadoEm = agora_();
  s.set('fixos/' + f.fid, f);
  return f;
}

// Depois de mudar um fixo: os lançamentos deste mês em diante (que ninguém editou à mão) acompanham.
function propagarFixo_(s, f) {
  const desde = mesHoje_();
  s.chaves('g/').forEach(k => {
    const p = k.split('/');
    if (p[2] !== 'fixo-' + f.fid || p[1] < desde) return;
    const doc = s.get(k);
    if (!doc || doc.editadoEm) return;
    if ((f.fim && p[1] > f.fim) || p[1] < f.inicio) { s.del(k); return; }
    const novo = lancamentoFixo_(f, p[1]);
    novo.criadoEm = doc.criadoEm;
    s.set(k, novo);
  });
}

// Cria os lançamentos fixos que faltam no mês pedido (só meses até o atual).
function materializar_(s, mes, cfg) {
  if (mes > mesHoje_()) return [];
  const criados = [];
  s.todos(cfg.modelos).forEach(f => {
    if (mes < f.inicio || (f.fim && mes > f.fim)) return;
    const doc = cfg.doc(f, mes);
    if (s.has(doc.key) || s.has(cfg.pulado + f.fid + '/' + mes)) return;
    s.set(doc.key, doc);
    criados.push(doc);
  });
  return criados;
}
// Previsão (sem gravar) dos fixos de um mês futuro.
function projetar_(s, mes, cfg) {
  const out = [];
  s.todos(cfg.modelos).forEach(f => {
    if (mes < f.inicio || (f.fim && mes > f.fim)) return;
    const doc = cfg.doc(f, mes);
    if (s.has(doc.key) || s.has(cfg.pulado + f.fid + '/' + mes)) return;
    doc.previsto = true;
    out.push(doc);
  });
  return out;
}
const CFG_FIXOS = { modelos: 'fixos/', pulado: 'fixo-pulado/', doc: (f, m) => lancamentoFixo_(f, m) };
const CFG_RFIXOS = { modelos: 'rfixos/', pulado: 'rfixo-pulado/', doc: (f, m) => receitaFixa_(f, m) };

function gastosDoMes_(s, mes, comPrevisao) {
  materializar_(s, mes, CFG_FIXOS);
  const lista = s.todos('g/' + mes + '/');
  if (comPrevisao && mes > mesHoje_()) lista.push.apply(lista, projetar_(s, mes, CFG_FIXOS));
  return lista.sort(porData_);
}

/* ======================= receitas ======================= */

const TIPOS_RECEITA = [
  { id: 'salario', nome: 'Salário', cor: '#1B7F47' },
  { id: 'bonus', nome: 'Bonificação / PLR', cor: '#2F7FD1' },
  { id: 'freelance', nome: 'Freelance', cor: '#8E44AD' },
  { id: 'extra', nome: 'Renda extra', cor: '#E0662B' },
  { id: 'decimo', nome: '13º / Férias', cor: '#C4A11E' },
  { id: 'rendimentos', nome: 'Rendimentos', cor: '#16A3A3' },
  { id: 'outros', nome: 'Outras receitas', cor: '#7D8791' },
];
const tipoOk_ = t => (TIPOS_RECEITA.some(x => x.id === t) ? t : 'outros');

function limparReceita_(b, quem) {
  const valor = valorPositivo_(b.valor);
  if (!ehData_(b.data)) throw new ErroDoUsuario('Informe a data no formato AAAA-MM-DD.');
  const tipo = tipoOk_(b.tipo);
  return {
    data: b.data, valor: valor, tipo: tipo,
    descricao: texto_(b.descricao, 120) || TIPOS_RECEITA.find(x => x.id === tipo).nome,
    quem: texto_(b.quem || quem || '', 40), nota: b.nota ? texto_(b.nota, 300) : null,
  };
}
function receitaFixa_(f, mes) {
  const id = 'rfixo-' + f.fid;
  return {
    id: id, key: 'r/' + mes + '/' + id, data: dataNoMes_(mes, f.dia), valor: f.valor, tipo: f.tipo,
    descricao: f.descricao, quem: f.quem, nota: null, origem: 'fixo', fixoId: f.fid, criadoPor: f.quem, criadoEm: agora_(),
  };
}
function limparReceitaFixa_(b, atual) {
  const f = Object.assign({}, atual || {});
  if (b.descricao != null || !atual) f.descricao = texto_(b.descricao, 120) || 'Salário';
  if (b.tipo != null || !atual) f.tipo = tipoOk_(b.tipo);
  if (b.valor != null || !atual) f.valor = valorPositivo_(b.valor);
  if (b.dia != null || !atual) { const d = Math.round(Number(b.dia)); if (!(d >= 1 && d <= 31)) throw new ErroDoUsuario('O dia vai de 1 a 31.'); f.dia = d; }
  if (b.quem != null) f.quem = texto_(b.quem, 40);
  if (b.inicio !== undefined || !atual) f.inicio = ehMes_(b.inicio) ? b.inicio : mesHoje_();
  if (b.fim !== undefined) f.fim = ehMes_(b.fim) ? b.fim : null;
  if (b.parar) f.fim = ehMes_(b.fim) ? b.fim : mesHoje_();
  if (b.reativar) f.fim = null;
  if (f.fim && f.fim < f.inicio) throw new ErroDoUsuario('O último mês não pode ser antes do primeiro.');
  return f;
}
function propagarReceitaFixa_(s, f) {
  const desde = mesHoje_();
  s.chaves('r/').forEach(k => {
    const p = k.split('/');
    if (p[2] !== 'rfixo-' + f.fid || p[1] < desde) return;
    const doc = s.get(k);
    if (!doc || doc.editadoEm) return;
    if ((f.fim && p[1] > f.fim) || p[1] < f.inicio) { s.del(k); return; }
    const novo = receitaFixa_(f, p[1]); novo.criadoEm = doc.criadoEm;
    s.set(k, novo);
  });
}
function receitasDoMes_(s, mes, comPrevisao) {
  materializar_(s, mes, CFG_RFIXOS);
  const lista = s.todos('r/' + mes + '/');
  if (comPrevisao && mes > mesHoje_()) lista.push.apply(lista, projetar_(s, mes, CFG_RFIXOS));
  return lista.sort(porData_);
}

function novaReceita_(s, eu, b) {
  const r = limparReceita_(b, eu.nome);
  if (b.repetir) {
    const f = limparReceitaFixa_({ descricao: r.descricao, tipo: r.tipo, valor: r.valor, dia: Number(r.data.slice(8)), quem: r.quem, inicio: mesDe_(r.data) }, null);
    f.fid = novoId_(12); f.fim = null; f.criadoPor = eu.nome; f.criadoEm = agora_();
    s.set('rfixos/' + f.fid, f);
    const doc = receitaFixa_(f, mesDe_(r.data));
    s.set(doc.key, doc);
    return { receita: doc };
  }
  const id = novoId_(12), key = 'r/' + mesDe_(r.data) + '/' + id;
  const doc = Object.assign(r, { id: id, key: key, origem: 'manual', criadoPor: eu.nome, criadoEm: agora_() });
  s.set(key, doc);
  return { receita: doc };
}
function editarReceita_(s, eu, key, b) {
  const atual = s.get(key);
  if (!atual) throw new ErroDoUsuario('Receita não encontrada.', 404);
  const r = limparReceita_(Object.assign({}, atual, b), atual.quem);
  const novoKey = 'r/' + mesDe_(r.data) + '/' + atual.id;
  const doc = Object.assign({}, atual, r, { key: novoKey, editadoPor: eu.nome, editadoEm: agora_() });
  s.set(novoKey, doc);
  if (novoKey !== key) { s.del(key); if (atual.fixoId) s.set('rfixo-pulado/' + atual.fixoId + '/' + key.split('/')[1], '1'); }
  return { receita: doc };
}
function apagarReceita_(s, key) {
  const atual = s.get(key);
  if (!atual) throw new ErroDoUsuario('Receita não encontrada.', 404);
  s.del(key);
  if (atual.fixoId) s.set('rfixo-pulado/' + atual.fixoId + '/' + key.split('/')[1], '1');
  return { ok: true };
}

/* ======================= painel ======================= */

const soma_ = (l, campo) => r2(l.reduce((t, x) => t + (Number(x[campo]) || 0), 0));
function resumoMes_(s, mes) {
  const passado = mes <= mesHoje_();
  const gastos = gastosDoMes_(s, mes, true), receitas = receitasDoMes_(s, mes, true);
  const fixos = gastos.filter(g => g.origem === 'fixo'), parcelas = gastos.filter(g => g.parcela);
  return {
    mes: mes, previsto: !passado,
    receitas: soma_(receitas, 'valor'), gastos: soma_(gastos, 'total'),
    fixos: soma_(fixos, 'total'), parcelas: soma_(parcelas, 'total'),
    variaveis: r2(soma_(gastos, 'total') - soma_(fixos, 'total') - soma_(parcelas, 'total')),
  };
}
function painel_(s, mes, n) {
  n = Math.max(3, Math.min(24, Number(n) || 12));
  const meses = [];
  for (let i = n - 1; i >= 0; i--) meses.push(resumoMes_(s, somaMes_(mes, -i)));
  const base = mes > mesHoje_() ? mes : mesHoje_();
  const futuro = [];
  for (let i = 1; i <= 6; i++) futuro.push(resumoMes_(s, somaMes_(base, i)));
  // parcelas que ainda vão vencer, por compra
  const abertas = {};
  s.chaves('g/').forEach(k => {
    if (k.split('/')[1] <= base) return;
    const g = s.get(k);
    if (!g || !g.parcela) return;
    const a = abertas[g.parcela.grupo] || (abertas[g.parcela.grupo] = { grupo: g.parcela.grupo, descricao: g.descricao, cartao: g.cartao, de: g.parcela.de, restantes: 0, valor: 0, ultima: '' });
    a.restantes++; a.valor = r2(a.valor + g.total); if (g.data > a.ultima) a.ultima = g.data;
  });
  const receitasMes = receitasDoMes_(s, mes, true), gastosMes = gastosDoMes_(s, mes, true);
  const agrupa = (l, chave, campo) => { const o = {}; l.forEach(x => { const k = x[chave] || 'Sem nome'; o[k] = r2((o[k] || 0) + (Number(x[campo]) || 0)); }); return o; };
  const ano = mes.slice(0, 4);
  const doAno = meses.filter(m => m.mes.slice(0, 4) === ano);
  return {
    mes: mes, mesAtual: mesHoje_(), meses: meses, futuro: futuro,
    parcelasAbertas: Object.keys(abertas).map(k => abertas[k]).sort((a, b) => b.valor - a.valor),
    receitasPorTipo: agrupa(receitasMes, 'tipo', 'valor'), receitasPorPessoa: agrupa(receitasMes, 'quem', 'valor'),
    gastosPorPessoa: agrupa(gastosMes, 'quem', 'total'),
    ano: { ano: ano, receitas: soma_(doAno, 'receitas'), gastos: soma_(doAno, 'gastos'), meses: doAno.length },
  };
}

/* ======================= nota fiscal (NFC-e) ======================= */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ccedil: 'ç', Ccedil: 'Ç', atilde: 'ã', Atilde: 'Ã', otilde: 'õ', Otilde: 'Õ', aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É', iacute: 'í', Iacute: 'Í', oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', acirc: 'â', Acirc: 'Â', ecirc: 'ê', Ecirc: 'Ê', ocirc: 'ô', Ocirc: 'Ô', agrave: 'à', Agrave: 'À', ordm: 'º', ordf: 'ª' };
const decode_ = s => String(s == null ? '' : s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => (ENT[n] != null ? ENT[n] : m));
const txt_ = s => decode_(String(s == null ? '' : s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
// "Qtde.:1" e "Vl. Unit.: 3,79": o rótulo vem antes do ":" e o ponto dele não é decimal
const numNf_ = s => { const t = txt_(s).replace(/^[^:]*:/, '').replace(/[^\d,.-]/g, ''); if (!t) return NaN; return parseFloat(t.indexOf(',') >= 0 ? t.replace(/\./g, '').replace(',', '.') : t); };
const span_ = (html, cls) => { const m = html.match(new RegExp('<span[^>]*class="' + cls + '"[^>]*>([\\s\\S]*?)</span>')); return m ? m[1] : ''; };

// Aceita só endereços de consulta de SEFAZ, para a função não virar um proxy aberto.
function urlPermitida_(raw) {
  const m = String(raw || '').trim().match(/^(https?):\/\/([^/?#:]+)(:\d+)?([^#]*)/i);
  if (!m) return null;
  const host = m[2].toLowerCase(), resto = m[4] || '/';
  if (!/\.gov\.br$/.test(host)) return null;
  if (!/nfc|nfe|qrcode|consulta/i.test(resto)) return null;
  // O link do QR code traz "|" (p=chave|2|1|1|hash): o UrlFetchApp do Google recusa esse caractere sem codificar.
  const seguro = resto.replace(/[|\s"<>\\^`{}]/g, c => encodeURIComponent(c));
  return 'https://' + host + seguro;
}
function chaveDaUrl_(raw) {
  const m = String(raw).match(/[?&]p=(\d{44})/) || String(raw).match(/(\d{44})/);
  return m ? m[1] : null;
}
function lerNfce_(html) {
  const itens = [];
  html.split(/<tr[^>]*id="Item\s*\+\s*\d+"[^>]*>/).slice(1).forEach(row => {
    row = row.split('</tr>')[0];
    const d = txt_(span_(row, 'txtTit'));
    if (!d) return;
    const cod = (txt_(span_(row, 'RCod')).match(/(\d{6,14})/) || [])[1] || null;
    const q = numNf_(span_(row, 'Rqtd')), vu = numNf_(span_(row, 'RvlUnit')), vt = numNf_(span_(row, 'valor'));
    const un = txt_(span_(row, 'RUN')).replace(/^UN:\s*/i, '').trim() || 'UN';
    itens.push({ d: d, cod: cod, q: isFinite(q) ? q : 1, un: un, vu: isFinite(vu) ? vu : null, vt: isFinite(vt) ? r2(vt) : 0 });
  });
  if (!itens.length) throw new Error('itens');
  const totais = {};
  const re = /<label>([^<]*)<\/label>\s*<span class="totalNumb[^"]*">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html))) totais[txt_(m[1]).toLowerCase()] = numNf_(m[2]);
  const pegar = function () { const ch = Array.prototype.slice.call(arguments); for (const k in totais) if (ch.some(c => k.indexOf(c) >= 0) && isFinite(totais[k])) return totais[k]; return NaN; };
  const somaItens = r2(itens.reduce((t, i) => t + i.vt, 0));
  const bruto = isFinite(pegar('valor total')) ? pegar('valor total') : somaItens;
  const desconto = isFinite(pegar('desconto')) ? pegar('desconto') : 0;
  const total = isFinite(pegar('a pagar')) ? pegar('a pagar') : r2(bruto - desconto);
  const loja = txt_((html.match(/<div[^>]*id="u20"[^>]*>([\s\S]*?)<\/div>/) || [])[1]) || null;
  const plano = txt_(html);
  const cnpj = (plano.match(/CNPJ:\s*([\d./-]{14,18})/) || [])[1] || null;
  const em = plano.match(/Emiss[aã]o:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}:\d{2})?/) || [];
  const chave = txt_(span_(html, 'chave')).replace(/\D/g, '') || null;
  const fp = html.match(/Forma de pagamento[\s\S]*?<label class="tx">([\s\S]*?)<\/label>/i);
  return {
    loja: loja, cnpj: cnpj, data: em[3] ? em[3] + '-' + em[2] + '-' + em[1] : null, hora: em[4] || null,
    chave: chave && chave.length === 44 ? chave : null, numero: (plano.match(/N[uú]mero:\s*(\d+)/) || [])[1] || null,
    pagamento: fp ? txt_(fp[1]) : null, bruto: r2(bruto), desconto: r2(desconto), total: r2(total), itens: itens,
  };
}
// Busca a página da nota na SEFAZ. A conexão de alguns estados cai de vez em quando: tenta até 3 vezes.
function baixarNota_(alvo) {
  const opts = { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9' } };
  let ultimo = '';
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = UrlFetchApp.fetch(alvo, opts);
      const cod = r.getResponseCode();
      if (cod < 400) return r.getContentText();
      ultimo = 'HTTP ' + cod;
      if (cod < 500) break;
    } catch (e) { ultimo = String((e && e.message) || e).slice(0, 160); }
    console.warn('SEFAZ tentativa ' + tentativa + ': ' + ultimo + ' | ' + alvo.slice(0, 90));
    if (tentativa < 3) Utilities.sleep(800 * tentativa);
  }
  throw new ErroDoUsuario('O site da SEFAZ não respondeu (' + ultimo + '). Tente de novo em alguns minutos ou use "Colar link da nota".', 504);
}

function importarNota_(s, bruto) {
  const alvo = urlPermitida_(bruto);
  if (!alvo) throw new ErroDoUsuario('Esse QR code não é de uma nota fiscal (NFC-e).');
  const chaveQr = chaveDaUrl_(alvo);
  if (chaveQr && s.get('nf/' + chaveQr)) return { duplicada: true, chave: s.get('nf/' + chaveQr) };
  const html = baixarNota_(alvo);
  let nota;
  try { nota = lerNfce_(html); } catch (e) {
    if (/captcha/i.test(html)) throw new ErroDoUsuario('A SEFAZ pediu uma verificação (captcha) em vez de mostrar a nota. Leia o QR code de novo, com ele inteiro na câmera, ou use "Colar link da nota" com o link completo.', 422);
    throw new ErroDoUsuario('Não consegui ler os itens dessa nota. Ela pode ainda não estar disponível na SEFAZ; tente mais tarde.', 422);
  }
  if (nota.chave && s.get('nf/' + nota.chave)) return { duplicada: true, chave: s.get('nf/' + nota.chave) };
  const ap = aprendido_(s);
  nota.itens = nota.itens.map(i => Object.assign(i, categorizar_(s, i.d, i.cod, ap)));
  nota.chave = nota.chave || chaveQr;
  return { nota: nota };
}

/* ======================= mercado ======================= */

function estadoMercado_(s) {
  const lista = s.todos('lista/').sort((a, b) => (a.feito - b.feito) || String(a.criadoEm).localeCompare(String(b.criadoEm)));
  return { lista: lista, compra: s.get('compra/atual') || null };
}
function precos_(s) { return s.chaves('precos/').map(k => Object.assign({ id: k.slice(7) }, s.get(k))); }

function adicionarNaLista_(s, eu, b) {
  const nome = texto_(b.nome, 80);
  if (!nome) throw new ErroDoUsuario('Digite o nome do item.');
  const mapa = mapaCat_(s);
  const item = { id: novoId_(12), nome: nome, qtd: Math.max(0.001, Number(b.qtd) || 1), cat: mapa[b.cat] ? b.cat : categorizar_(s, nome).cat, feito: false, criadoPor: eu.nome, criadoEm: agora_() };
  s.set('lista/' + item.id, item);
  return item;
}
function alterarItemLista_(s, id, mud) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new ErroDoUsuario('Item inválido.');
  const it = s.get('lista/' + id);
  if (!it) throw new ErroDoUsuario('Item não encontrado.', 404);
  if (mud.qtd != null) it.qtd = Math.max(0.001, Number(mud.qtd) || 1);
  if (mud.feito != null) it.feito = !!mud.feito;
  if (mud.porCarrinho != null) it.porCarrinho = !!mud.porCarrinho;
  if (mud.nome) it.nome = texto_(mud.nome, 80);
  s.set('lista/' + id, it);
  return it;
}
function comecarCompra_(s, eu, b) {
  const loja = texto_(b.loja, 60);
  if (!loja) throw new ErroDoUsuario('Digite o nome do mercado.');
  const atual = s.get('compra/atual');
  if (atual) return atual;
  const c = { id: novoId_(12), loja: loja, inicio: agora_(), por: eu.nome, itens: [] };
  s.set('compra/atual', c);
  return c;
}
function salvarCarrinho_(s, b) {
  const atual = s.get('compra/atual');
  if (!atual || atual.id !== b.id) throw new ErroDoUsuario('Essa compra já foi finalizada ou cancelada.', 409);
  if (!Array.isArray(b.itens)) throw new ErroDoUsuario('Carrinho inválido.');
  const mapa = mapaCat_(s);
  atual.itens = b.itens.slice(0, 400).map(i => ({
    id: /^[\w-]{4,20}$/.test(i.id || '') ? i.id : novoId_(12),
    nome: texto_(i.nome, 100) || 'Produto', preco: r2(Math.max(0, Number(i.preco) || 0)),
    qtd: Math.max(0.001, Number(i.qtd) || 1), un: ['un', 'kg', 'L'].indexOf(i.un) >= 0 ? i.un : 'un',
    cat: mapa[i.cat] ? i.cat : 'mercado', listaId: /^[a-f0-9]{12}$/.test(i.listaId || '') ? i.listaId : null,
  }));
  s.set('compra/atual', atual);
  return atual;
}
// Guarda o preço pago de cada produto, para comparar nas próximas compras e sugerir a lista.
function registrarPrecos_(s, itens, info) {
  const porSlug = {};
  itens.forEach(i => { const k = slug_(i.nome); if (!porSlug[k]) porSlug[k] = Object.assign({}, i); else porSlug[k].qtd += i.qtd; });
  Object.keys(porSlug).forEach(k => {
    const i = porSlug[k];
    const p = s.get('precos/' + k) || { nome: i.nome, cat: i.cat, un: i.un, hist: [] };
    p.nome = i.nome; p.cat = i.cat; p.un = i.un;
    p.hist = p.hist.concat([{ data: info.data, preco: i.preco, qtd: i.qtd, loja: info.loja, origem: info.origem }]).slice(-60);
    s.set('precos/' + k, p);
  });
}
function finalizarCompra_(s, eu, b) {
  const c = s.get('compra/atual');
  if (!c || c.id !== b.id) throw new ErroDoUsuario('Essa compra já foi finalizada ou cancelada.', 409);
  if (!c.itens.length) { s.del('compra/atual'); return { vazia: true }; }
  const itens = c.itens.map(i => ({ d: i.nome, cod: null, q: i.qtd, un: i.un.toUpperCase(), vu: i.preco, vt: r2(i.preco * i.qtd), cat: i.cat }));
  const data = ehData_(b.data) ? b.data : hojeISO_();
  const g = limparGasto_(s, { data: data, descricao: 'Mercado · ' + c.loja, loja: c.loja, quem: b.quem || eu.nome, pagamento: b.pagamento, cartao: b.cartao, parcelas: b.parcelas, total: itens.reduce((t, i) => t + i.vt, 0), itens: itens, origem: 'mercado' }, eu.nome);
  const docs = gravarCompra_(s, eu, g);
  docs.forEach(d => { d.compraId = c.id; s.set(d.key, d); });
  aprender_(s, itens);
  registrarPrecos_(s, c.itens, { data: data, loja: c.loja, origem: 'etiqueta' });
  estadoMercado_(s).lista.filter(i => i.feito).forEach(i => s.del('lista/' + i.id));
  s.del('compra/atual');
  return { gasto: docs[0], gastos: docs };
}

const PROMPT_ETQ = 'A imagem é a foto de uma etiqueta de preço de supermercado no Brasil (etiqueta de gôndola, adesivo no produto ou placa de hortifrúti/açougue). Extraia os dados e responda apenas com um objeto JSON:\n' +
  '{"descricao": string, "preco": number, "preco_normal": number|null, "unidade": "un"|"kg"|"L", "categoria": string, "confianca": "alta"|"media"|"baixa"}\n' +
  'Regras:\n- "descricao": nome do produto com marca e tamanho, por extenso. Ex.: etiqueta "CAF PILAO TRAD 500G" -> "Café Pilão Tradicional 500g".\n' +
  '- "preco": valor a pagar por 1 unidade (ou por kg/L), como número. Com preço promocional ou de atacado válido para 1 unidade, use o menor. Se o preço de atacado só vale a partir de várias unidades, use o preço unitário normal.\n' +
  '- "preco_normal": preço "de" sem desconto, se aparecer; senão null.\n- "unidade": "kg" só quando o preço é por quilo (a granel/pesado); "L" só para vendido por litro a granel; senão "un".\n' +
  '- "categoria": um destes ids: {CATS}.\n- Campo ilegível: null. Nunca invente o preço.';

function lerEtiqueta_(s, b) {
  const chave = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!chave) throw new ErroDoUsuario('A leitura automática ainda não está ativa. Preencha os campos à mão.', 503);
  const m = String(b.imagem || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new ErroDoUsuario('Foto inválida. Tente de novo.');
  if (m[2].length > 4000000) throw new ErroDoUsuario('Foto grande demais. Tente de novo.');
  const cats = categorias_(s);
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: b.cuidado ? 'claude-sonnet-5-5' : 'claude-haiku-5-5', max_tokens: 400,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: PROMPT_ETQ.replace('{CATS}', cats.map(c => c.id).join(', ')) }] }],
    }),
  });
  if (r.getResponseCode() >= 400) { console.error('etiqueta', r.getResponseCode(), r.getContentText().slice(0, 300)); throw new ErroDoUsuario('Não consegui ler a etiqueta agora. Preencha os campos à mão ou tente de novo.', 502); }
  const resp = JSON.parse(r.getContentText());
  const texto = (resp.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let j;
  try { j = JSON.parse(texto.match(/\{[\s\S]*\}/)[0]); } catch (e) { throw new ErroDoUsuario('Não entendi essa etiqueta. Tente outra foto ou preencha à mão.', 422); }
  const preco = typeof j.preco === 'number' ? j.preco : parseFloat(String(j.preco == null ? '' : j.preco).replace(',', '.'));
  const mapa = mapaCat_(s);
  return {
    descricao: j.descricao ? String(j.descricao).slice(0, 100) : '',
    preco: isFinite(preco) && preco > 0 ? r2(preco) : null,
    preco_normal: typeof j.preco_normal === 'number' && j.preco_normal > preco ? r2(j.preco_normal) : null,
    unidade: ['un', 'kg', 'L'].indexOf(j.unidade) >= 0 ? j.unidade : 'un',
    categoria: mapa[j.categoria] ? j.categoria : categorizar_(s, j.descricao || '').cat,
    confianca: ['alta', 'media', 'baixa'].indexOf(j.confianca) >= 0 ? j.confianca : 'media',
  };
}

/* ======================= importação do app antigo ======================= */

const IMPORTAVEIS = /^(g\/\d{4}-\d{2}\/[\w-]+|nf\/\d{44}|aprendido|fixos\/[\w-]+|fixo-pulado\/[\w-]+\/\d{4}-\d{2}|lista\/[\w-]+|compra\/atual|precos\/[\w-]+|config\/caderno-importado)$/;
function importar_(s, eu, b) {
  if (!eu.admin) throw new ErroDoUsuario('Só quem criou a casa pode importar dados.', 403);
  const dados = b.dados;
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw new ErroDoUsuario('Arquivo inválido: escolha o backup .json do app antigo.');
  let n = 0, ignorados = 0;
  Object.keys(dados).forEach(k => {
    if (!IMPORTAVEIS.test(k)) { ignorados++; return; }
    s.set(k, dados[k]); n++;
  });
  return { importados: n, ignorados: ignorados };
}

/* ======================= rotas ======================= */

function rotas_(s, req) {
  const p = req.partes, m = req.method, b = req.body, q = req.query;
  const r0 = p[0], r1 = p[1], r2_ = p[2], r3 = p[3];

  // ---- abertas (sem login) ----
  if (r0 === 'ping') return ok_({ ok: true, versao: VERSAO });
  if (r0 === 'estado' && m === 'GET') return ok_(estadoContas_(s));
  if (r0 === 'criar-conta' && m === 'POST') return ok_(criarConta_(s, b), 201);
  if (r0 === 'entrar' && m === 'POST') return ok_(entrar_(s, b));
  if (r0 === 'aceitar-convite' && m === 'POST') return ok_(aceitarConvite_(s, b), 201);

  const eu = usuarioDaSessao_(s, req.token);
  if (!eu) return { status: 401, body: { erro: 'Sua sessão terminou. Entre de novo.' } };

  // ---- conta ----
  if (r0 === 'inicio' && m === 'GET') return ok_({ usuario: publico_(eu), categorias: categorias_(s), cartoes: cartoes_(s), tiposReceita: TIPOS_RECEITA, pagamentos: PAGAMENTOS, mesAtual: mesHoje_(), versao: VERSAO });
  if (r0 === 'eu' && m === 'GET') return ok_({ usuario: publico_(eu) });
  if (r0 === 'sair' && m === 'POST') { s.del('sessoes/' + eu.token); return ok_({ ok: true }); }
  if (r0 === 'senha' && m === 'POST') { trocarSenha_(s, eu, b); return ok_({ ok: true }); }
  if (r0 === 'usuarios' && m === 'GET' && !r1) return ok_({ usuarios: usuarios_(s).map(publico_) });
  if (r0 === 'usuarios' && m === 'DELETE' && r1) { removerUsuario_(s, eu, r1); return ok_({ ok: true }); }
  if (r0 === 'convites' && m === 'POST') return ok_(criarConvite_(s, eu, b), 201);
  if (r0 === 'importar' && m === 'POST') return ok_(importar_(s, eu, b));

  // ---- categorias ----
  if (r0 === 'categorias') {
    if (m === 'GET' && !r1) return ok_({ categorias: categorias_(s) });
    if (m === 'POST' && !r1) return ok_({ categoria: criarCategoria_(s, b), categorias: categorias_(s) }, 201);
    if (m === 'PUT' && r1 === 'ordem') return ok_({ categorias: ordenarCategorias_(s, b.ordem) });
    if (m === 'PUT' && r1) return ok_({ categoria: alterarCategoria_(s, r1, b), categorias: categorias_(s) });
    if (m === 'POST' && r1 && r2_ === 'juntar') return ok_(Object.assign(juntarCategoria_(s, r1, b.destino), { categorias: categorias_(s) }));
    if (m === 'DELETE' && r1) return ok_(Object.assign(juntarCategoria_(s, r1, 'outros'), { categorias: categorias_(s) }));
  }

  // ---- cartões ----
  if (r0 === 'cartoes') {
    const lista = cartoes_(s);
    if (m === 'GET' && !r1) return ok_({ cartoes: lista });
    if (m === 'POST' && !r1) { const c = limparCartao_(b, null); c.id = novoId_(8); lista.push(c); s.set('config/cartoes', lista); return ok_({ cartao: c, cartoes: lista }, 201); }
    const i = lista.findIndex(c => c.id === r1);
    if (r1 && i < 0) throw new ErroDoUsuario('Cartão não encontrado.', 404);
    if (m === 'PUT' && r1) { lista[i] = limparCartao_(b, lista[i]); s.set('config/cartoes', lista); return ok_({ cartao: lista[i], cartoes: lista }); }
    if (m === 'DELETE' && r1) { lista.splice(i, 1); s.set('config/cartoes', lista); return ok_({ cartoes: lista }); }
  }

  // ---- nota fiscal ----
  if (r0 === 'nfce' && m === 'POST') return ok_(importarNota_(s, b.url));

  // ---- gastos ----
  if (r0 === 'gastos') {
    if (m === 'GET' && !r1) {
      if (!ehMes_(q.mes)) throw new ErroDoUsuario('Mês inválido.');
      return ok_({ gastos: gastosDoMes_(s, q.mes, true) });
    }
    if (m === 'POST' && !r1) return ok_(novoGasto_(s, eu, b), 201);
    if (p.length === 3 && ehMes_(r1)) {
      const key = 'g/' + r1 + '/' + r2_;
      if (m === 'DELETE') return ok_(apagarGasto_(s, key));
      if (m === 'PUT') return ok_(editarGasto_(s, eu, key, b));
    }
  }
  // GET gasto?key=g/AAAA-MM/id  (abrir uma nota já lançada a partir do aviso de duplicada)
  if (r0 === 'gasto' && m === 'GET') {
    const key = String(q.key || '');
    if (!/^g\/\d{4}-\d{2}\/[\w-]+$/.test(key)) throw new ErroDoUsuario('Lançamento inválido.');
    const g = s.get(key);
    if (!g) throw new ErroDoUsuario('Lançamento não encontrado.', 404);
    return ok_({ gasto: g });
  }
  // GET mes?mes=AAAA-MM: gastos e receitas do mês e do mês anterior (Resumo)
  if (r0 === 'mes' && m === 'GET') {
    if (!ehMes_(q.mes)) throw new ErroDoUsuario('Mês inválido.');
    const ant = somaMes_(q.mes, -1);
    return ok_({ mes: q.mes, gastos: gastosDoMes_(s, q.mes, true), receitas: receitasDoMes_(s, q.mes, true), anterior: { mes: ant, gastos: gastosDoMes_(s, ant, true) } });
  }

  // ---- gastos fixos ----
  if (r0 === 'fixos') {
    if (m === 'GET' && !r1) return ok_({ fixos: s.todos('fixos/').sort((a, c) => a.descricao.localeCompare(c.descricao)), mesAtual: mesHoje_() });
    if (m === 'POST' && !r1) return ok_({ fixo: novoFixo_(s, eu, b) }, 201);
    if (r1 && /^[a-f0-9]{12}$/.test(r1)) {
      const f = s.get('fixos/' + r1);
      if (!f) throw new ErroDoUsuario('Gasto fixo não encontrado.', 404);
      if (m === 'PUT') { const novo = limparFixo_(s, b, f); s.set('fixos/' + r1, novo); propagarFixo_(s, novo); return ok_({ fixo: novo }); }
      if (m === 'DELETE') {
        const desde = mesHoje_();
        s.chaves('g/').forEach(k => { const x = k.split('/'); if (x[2] === 'fixo-' + r1 && x[1] >= desde) { const d = s.get(k); if (d && !d.editadoEm) s.del(k); } });
        s.del('fixos/' + r1);
        return ok_({ ok: true });
      }
    }
  }

  // ---- receitas ----
  if (r0 === 'receitas') {
    if (m === 'GET' && !r1) {
      if (!ehMes_(q.mes)) throw new ErroDoUsuario('Mês inválido.');
      return ok_({ receitas: receitasDoMes_(s, q.mes, true) });
    }
    if (m === 'POST' && !r1) return ok_(novaReceita_(s, eu, b), 201);
    if (p.length === 3 && ehMes_(r1)) {
      const key = 'r/' + r1 + '/' + r2_;
      if (m === 'PUT') return ok_(editarReceita_(s, eu, key, b));
      if (m === 'DELETE') return ok_(apagarReceita_(s, key));
    }
  }
  if (r0 === 'rfixos') {
    if (m === 'GET' && !r1) return ok_({ fixos: s.todos('rfixos/').sort((a, c) => a.descricao.localeCompare(c.descricao)), mesAtual: mesHoje_() });
    if (r1 && /^[a-f0-9]{12}$/.test(r1)) {
      const f = s.get('rfixos/' + r1);
      if (!f) throw new ErroDoUsuario('Receita fixa não encontrada.', 404);
      if (m === 'PUT') { const novo = limparReceitaFixa_(b, f); s.set('rfixos/' + r1, novo); propagarReceitaFixa_(s, novo); return ok_({ fixo: novo }); }
      if (m === 'DELETE') {
        const desde = mesHoje_();
        s.chaves('r/').forEach(k => { const x = k.split('/'); if (x[2] === 'rfixo-' + r1 && x[1] >= desde) { const d = s.get(k); if (d && !d.editadoEm) s.del(k); } });
        s.del('rfixos/' + r1);
        return ok_({ ok: true });
      }
    }
  }

  // ---- painel ----
  if (r0 === 'painel' && m === 'GET') {
    const mes = ehMes_(q.mes) ? q.mes : mesHoje_();
    return ok_(painel_(s, mes, q.n));
  }

  // ---- mercado ----
  if (r0 === 'etiqueta' && m === 'POST') return ok_({ etiqueta: lerEtiqueta_(s, b) });
  if (r0 === 'precos' && m === 'GET') return ok_({ precos: precos_(s) });
  if (r0 === 'mercado') {
    if (m === 'GET' && !r1) return ok_(estadoMercado_(s));
    if (r1 === 'lista') {
      if (m === 'POST' && !r2_) return ok_({ item: adicionarNaLista_(s, eu, b) }, 201);
      if (m === 'PUT' && r2_) return ok_({ item: alterarItemLista_(s, r2_, b) });
      if (m === 'DELETE' && r2_) { s.del('lista/' + r2_); return ok_({ ok: true }); }
    }
    if (r1 === 'compra') {
      if (m === 'POST' && !r2_) return ok_({ compra: comecarCompra_(s, eu, b) }, 201);
      if (m === 'PUT' && !r2_) return ok_({ compra: salvarCarrinho_(s, b) });
      if (m === 'DELETE' && !r2_) { s.del('compra/atual'); return ok_({ ok: true }); }
      if (m === 'POST' && r2_ === 'finalizar') return ok_(finalizarCompra_(s, eu, b), 201);
    }
  }
  void r3;
  return { status: 404, body: { erro: 'Rota não encontrada.' } };
}

/* ======================= planilha legível ======================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Gastos da Casa')
    .addItem('Atualizar abas de leitura', 'atualizarPlanilhas')
    .addItem('Atualizar todo dia (automático)', 'instalarAtualizacaoDiaria')
    .addToUi();
}

// Gera as abas "Lançamentos" e "Receitas" a partir dos dados do app (só leitura: o app não lê essas abas).
function atualizarPlanilhas() {
  const s = Store_.abrir();
  const cats = mapaCat_(s), cartoes = {};
  cartoes_(s).forEach(c => { cartoes[c.id] = c.nome; });
  const tipos = {}; TIPOS_RECEITA.forEach(t => { tipos[t.id] = t.nome; });
  const gastos = s.todos('g/').sort((a, b) => a.data.localeCompare(b.data));
  const linhasG = [['Data', 'Mês', 'Descrição', 'Categoria', 'Valor', 'Quem pagou', 'Pagamento', 'Cartão', 'Parcela', 'Origem']];
  gastos.forEach(g => {
    const partes = {};
    if (g.itens && g.itens.length) {
      const soma = g.itens.reduce((t, i) => t + i.vt, 0), f = soma > 0 ? g.total / soma : 1;
      g.itens.forEach(i => { partes[i.cat] = (partes[i.cat] || 0) + i.vt * f; });
    } else partes[g.cat || 'outros'] = g.total;
    Object.keys(partes).forEach(c => linhasG.push([g.data, g.data.slice(0, 7), g.descricao, (cats[c] || { nome: c }).nome, r2(partes[c]), g.quem || '', g.pagamento || '', cartoes[g.cartao] || '', g.parcela ? g.parcela.n + '/' + g.parcela.de : '', g.origem || '']));
  });
  const receitas = s.todos('r/').sort((a, b) => a.data.localeCompare(b.data));
  const linhasR = [['Data', 'Mês', 'Descrição', 'Tipo', 'Valor', 'Quem', 'Origem']];
  receitas.forEach(r => linhasR.push([r.data, r.data.slice(0, 7), r.descricao, tipos[r.tipo] || r.tipo, r.valor, r.quem || '', r.origem || '']));
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [['Lançamentos', linhasG], ['Receitas', linhasR]].forEach(par => {
    const aba = ss.getSheetByName(par[0]) || ss.insertSheet(par[0]);
    aba.clearContents();
    aba.getRange(1, 1, par[1].length, par[1][0].length).setValues(par[1]);
    aba.setFrozenRows(1);
    aba.getRange(2, 5, Math.max(1, par[1].length - 1), 1).setNumberFormat('R$ #,##0.00');
  });
}

function instalarAtualizacaoDiaria() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'atualizarPlanilhas').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('atualizarPlanilhas').timeBased().everyDays(1).atHour(5).create();
}
