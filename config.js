// ===== CONFIG FAROL =====
window.FAROL_SOURCE = 'trello';

// suas credenciais
window.TRELLO_KEY   = '0ec7348aeee93cea559191dd6f6df55e';
window.TRELLO_TOKEN = 'ATTAc9f6567905912758a97679ea41cd69ebec04fc7509e08f9fb4474e10bcb01c1cB2E329F8';

// seu board (shortLink na URL do Trello)
window.TRELLO_BOARD_IDS = ['o6b4gZHW'];

// mapeamento das listas do quadro
window.LISTS = {
  backlog: ['BACKLOG DO PRODUTO','BACKLOG DA SPRINT'],
  fazendo: ['FAZENDO'],
  aguardando: [
    'AGUARDANDO / EM ANDAMENTO',
    'AGUARDANDO EM ANDAMENTO DEPENDENTE DE TERCEIROS'
  ],
  feito: ['FEITO'],
  informativas: ['PRODUTIVIDADE DA SEMANA','ATAS - REUNIÃO DIÁRIA']
};

// parâmetros de negócio
window.AGING_DAYS = 7;        // considera "aged" se parado >=7 dias
window.MAX_ACTION_CARDS = 20; // nº máximo de cards que busca trilha (p/ evitar limite da API)
window.THROTTLE_MS = 300;     // intervalo entre chamadas à API (ms)
