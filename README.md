# Gastos da Casa

App do casal para despesas e receitas: lê o QR code da nota fiscal (NFC-e), separa os itens por categoria,
parcela compras no cartão, lança gastos e salários fixos todo mês, mostra o resumo do mês e o painel de
receitas x gastos. Tem também a lista de compras do mercado com histórico de preços.

- **Telas:** esta pasta, publicada pelo **GitHub Pages** (gratuito).
- **Backend e dados:** **Google Apps Script** ligado a uma **Planilha Google** no seu Drive (gratuito).
  O código do backend fica em `backend/`. Nenhum dado da casa fica neste repositório.

## Implantação (uma vez só, ~10 minutos)

### 1. Backend (Apps Script + Planilha)
1. No Google Drive, crie uma planilha nova chamada **Gastos da Casa · dados**.
2. Na planilha: **Extensões › Apps Script**.
3. Apague o conteúdo de `Código.gs` e cole todo o arquivo [`backend/Code.gs`](backend/Code.gs).
4. Em **Configurações do projeto** (engrenagem), marque **"Mostrar o arquivo de manifesto appsscript.json"**,
   volte ao editor e cole o conteúdo de [`backend/appsscript.json`](backend/appsscript.json).
5. Salve. Clique em **Implantar › Nova implantação** › tipo **App da Web**:
   - Executar como: **Eu**
   - Quem pode acessar: **Qualquer pessoa**
6. Autorize o acesso pedido pelo Google e copie o **URL do app da Web** (termina em `/exec`).

> "Qualquer pessoa" só permite *chamar* o backend; os dados continuam protegidos por nome e senha de cada um.

### 2. Ligar as telas ao backend
Edite o arquivo [`config.js`](config.js) aqui no GitHub e cole o link em `backendUrl`:
```js
window.GASTOS_CONFIG = { backendUrl: "https://script.google.com/macros/s/.../exec" };
```

### 3. Primeiro acesso
1. Abra o site do GitHub Pages, crie a sua conta (você vira o administrador).
2. Em **Conta › Trazer dados do app antigo**, escolha o arquivo de backup `.json` do app antigo.
3. Em **Conta › Pessoas da casa**, gere o convite para a outra pessoa.
4. Em **Ajustes**, cadastre os cartões (com o dia de fechamento) e os orçamentos das categorias.
5. Em **Receitas**, lance os salários marcando **"Repetir todo mês"**.

### Opcional
- **Leitura de etiqueta por foto (Mercado):** no Apps Script, *Configurações do projeto › Propriedades do script*,
  crie `ANTHROPIC_API_KEY` com uma chave da API da Anthropic. Sem ela, o Mercado funciona digitando os dados.
- **Planilha legível:** na planilha aparece o menu **Gastos da Casa › Atualizar abas de leitura**, que gera as
  abas *Lançamentos* e *Receitas* (uma linha por gasto/categoria) para filtros e tabelas dinâmicas.

## Atualizar
- **Telas:** edite e envie para o GitHub; o site se atualiza em 1 ou 2 minutos.
- **Backend:** se `backend/Code.gs` mudar, cole o arquivo no Apps Script e faça
  **Implantar › Gerenciar implantações › editar › Nova versão** (o link `/exec` continua o mesmo).

## Como os dados são guardados
Aba `dados` da planilha, uma linha por registro (`chave | atualizado | JSON`). Não edite essa aba à mão:
use as abas de leitura para consultas. Detalhes das chaves no topo de `backend/Code.gs`.
