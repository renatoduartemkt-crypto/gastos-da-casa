// Categorias e regras compartilhadas entre o site e a função do servidor.
// A ordem é a da tela de lançamento: o que vem em nota de mercado primeiro, depois casa, carro e o resto.
export const CATEGORIAS = [
  { id: 'mercado', nome: 'Alimentação', cor: '#2E8B57' },
  { id: 'bebidas', nome: 'Bebidas', cor: '#2F7FD1' },
  { id: 'alcool', nome: 'Bebidas alcoólicas', cor: '#8E44AD' },
  { id: 'limpeza', nome: 'Limpeza', cor: '#16A3A3' },
  { id: 'higiene', nome: 'Higiene e beleza', cor: '#D2569B' },
  { id: 'casa', nome: 'Utilidades do lar', cor: '#A0763C' },
  { id: 'pet', nome: 'Pet', cor: '#C9822B' },
  { id: 'farmacia', nome: 'Farmácia e saúde', cor: '#D64541' },
  { id: 'habitacao', nome: 'Habitação', cor: '#1F4E79' },
  { id: 'contas', nome: 'Contas da casa', cor: '#3F6E8C' },
  { id: 'combustivel', nome: 'Combustível', cor: '#E8A317' },
  { id: 'manutencao', nome: 'Manutenção do carro', cor: '#6B5B95' },
  { id: 'financiamento_carro', nome: 'Financiamento do carro', cor: '#34495E' },
  { id: 'transporte', nome: 'Transporte e apps', cor: '#5662C9' },
  { id: 'assinaturas', nome: 'Streaming e assinaturas', cor: '#E50914' },
  { id: 'compras_online', nome: 'Compras online', cor: '#EE4D2D' },
  { id: 'restaurante', nome: 'Restaurantes e delivery', cor: '#E0662B' },
  { id: 'lazer', nome: 'Lazer', cor: '#C4A11E' },
  { id: 'vestuario', nome: 'Vestuário', cor: '#9C5D7A' },
  { id: 'educacao', nome: 'Educação', cor: '#4C9A2A' },
  { id: 'outros', nome: 'Outros', cor: '#7D8791' },
];
export const CAT = Object.fromEntries(CATEGORIAS.map(c => [c.id, c]));

// As categorias podem ser criadas, renomeadas, coloridas e juntadas pelo casal (Ajustes).
// O servidor manda a lista atual; as duas estruturas acima são atualizadas no lugar.
export function definirCategorias(lista) {
  if (!Array.isArray(lista) || !lista.length) return;
  CATEGORIAS.splice(0, CATEGORIAS.length, ...lista);
  for (const k of Object.keys(CAT)) delete CAT[k];
  for (const c of lista) CAT[c.id] = c;
}

// Atalhos de descrição no lançamento manual; os marcados com fixo: true já sugerem "repetir todo mês".
export const SUGESTOES = {
  assinaturas: [['Netflix', true], ['Claude', true], ['Amazon Prime', true], ['YouTube Premium', true], ['Google One', true], ['Google', true], ['Spotify', true], ['Disney+', true]],
  compras_online: [['Shopee'], ['Mercado Livre'], ['Amazon'], ['AliExpress'], ['Shein']],
  combustivel: [['Gasolina'], ['Etanol'], ['Diesel']],
  manutencao: [['Troca de óleo'], ['Revisão'], ['Pneus'], ['Lavagem'], ['Mecânico'], ['Seguro do carro'], ['IPVA'], ['Licenciamento']],
  financiamento_carro: [['Parcela do financiamento do carro', true]],
  habitacao: [['Parcela do financiamento do apartamento', true], ['Condomínio', true], ['IPTU'], ['Seguro residencial']],
  contas: [['Luz', true], ['Água', true], ['Internet', true], ['Celular', true], ['Gás']],
  transporte: [['Uber'], ['99'], ['Ônibus'], ['Estacionamento'], ['Pedágio']],
  restaurante: [['iFood'], ['Restaurante'], ['Lanche']],
  lazer: [['Cinema'], ['Passeio'], ['Viagem'], ['Show']],
  vestuario: [['Roupas'], ['Calçados']],
};

export const normDesc = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();

// Descrições de NFC-e vêm abreviadas ("D A AXE 200ML", "ST ALBANY 80G", "LAV LOU MINUAN").
// A ordem importa: limpeza antes de bebidas por causa de "AGUA SANITARIA".
const REGRAS = [
  // notas de posto e de autopeças
  ['combustivel', /\b(GASOLINA|ETANOL|DIESEL|GNV|ALCOOL COMUM|ALCOOL HIDRAT|ETANOL HIDRAT|ARLA)\b/],
  ['manutencao', /\b(OLEO MOTOR|OLEO LUBR|LUBRIFICANTE|5W30|5W40|10W40|15W40|FLUIDO FREIO|FLUIDO ARREF|ADITIVO RADIADOR|PALHETA|PNEU|PASTILHA|FILTRO OLEO|FILTRO AR|FILTRO COMB|LAVAGEM|DUCHA)\b/],
  ['alcool', /\b(CERV|CERVEJA|CHOPP|VINHO|VODKA|WHISKY|WHISKEY|GIN|CACHACA|ESPUMANTE|LICOR|RUM|TEQUILA|SAKE|APERITIVO)\b/],
  ['limpeza', /\b(LAV|LAVA|DET|DETERG|DETERGENTE|AMAC|AMACIANTE|DESINF|DESINFETANTE|SANIT|SANITARIA|ALVEJ|ALVEJANTE|SAPOLIO|ESPONJA|ESPONJ|TOALHA|SACO LIXO|SACO DE LIXO|SACOS DE LIXO|SC LIXO|LIMP|LIMPADOR|MULTIUSO|PINHO|CLORO|ODORIZ|ODORIZADOR|INSET|INSETICIDA|LUSTRA|ESFREG|PANO|TIRA MANCHA|SABAO PO|SAB PO|SABAO BARRA|VASSOURA|RODO)\b/],
  ['higiene', /^(ST|SAB|SABON|SH|SHAMP|COND|CD|ED|D A|DS|DES|DESOD|PH|AP|ABS|HID|ENX)\b/],
  ['higiene', /\b(SABONETE|SHAMPOO|CONDICIONADOR|CREME DENT|CR DENT|DENTAL|ESCOVA|DESODORANTE|PAP HIG|HIGIENICO|ABSORV|ABSORVENTE|FRALDA|FRALD|COTONETE|HASTES|FIO DENT|ENXAG|ENXAGUANTE|PROTETOR SOLAR|HIDRATANTE|BARBEAR|APAR|LENCO UMED|LEN UMED|ESMALTE|ACETONA|TINTURA|GEL CAB)\b/],
  ['casa', /\b(FILME PVC|PVC|PAPEL ALUM|PAP ALUM|ALUMINIO|FILTR|FILTRO|PILHA|PILHAS|LAMP|LAMPADA|VELA|COPO DESC|PRATO DESC|DESCART|FOSFORO|ISQUEIRO|PRENDEDOR|GUARDANAPO|GUARD|SACO FREEZER|SACO ZIP|CARVAO)\b/],
  // "PET" sozinho é garrafa (ÓLEO 900ML PET), não animal
  ['pet', /\b(RACAO|RAC|PETSHOP|PET SHOP|AREIA GATO|AREIA SANIT|PETISCO|WHISKAS|PEDIGREE|GOLDEN|PREMIER|FRISKIES|DOG CHOW|CAT CHOW|BIFINHO)\b/],
  ['farmacia', /\b(DIPIRONA|PARACETAMOL|DORFLEX|NEOSALDINA|TYLENOL|IBUPROFENO|BAND AID|CURATIVO|ALCOOL 70|ALC 70|SORO FISIOL|VITAMINA|TERMOMETRO|GAZE|ESPARADRAPO)\b/],
  ['bebidas', /\b(BEB|REFRIG|REFRI|SUCO|NECTAR|AGUA|ENERG|ENERGETICO|ISOTON|ISOTONICO|GATORADE|CHA|COCA|GUARANA|H2OH|PURO COCO|TONICA|KOMBUCHA)\b/],
];

// aprendido: { porCodigo: {ean: cat}, porDescricao: {DESC NORMALIZADA: cat} }
export function categorizar(desc, cod, aprendido) {
  const d = normDesc(desc);
  const porCod = aprendido?.porCodigo?.[cod];
  if (cod && porCod && CAT[porCod]) return { cat: porCod, fonte: 'aprendido' };
  const porDesc = aprendido?.porDescricao?.[d];
  if (porDesc && CAT[porDesc]) return { cat: porDesc, fonte: 'aprendido' };
  for (const [cat, re] of REGRAS) if (re.test(d)) return { cat, fonte: 'regra' };
  // num supermercado, o que não casou com nenhuma regra quase sempre é comida
  return { cat: 'mercado', fonte: 'padrao' };
}
