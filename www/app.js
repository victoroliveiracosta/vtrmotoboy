// ---------------------------------------------------------------------
// VTR Entregador - app do entregador do VTR PDV.
// Sem bundler de propósito (mesmo estilo do resto do VTR PDV): os
// plugins nativos do Capacitor ficam disponíveis direto em
// window.Capacitor.Plugins, sem precisar importar/empacotar nada.
// ---------------------------------------------------------------------

const API_BASE = 'https://vtrpdv.com/api';
const CHAVE_TOKEN = 'vtr_motoboy_token';

let tokenAtual = null;
let watcherIdGps = null;
let intervalAtualizarEntregas = null;
let ultimasEntregasCarregadas = [];
let motoboyIdAtual = null;
let motoboyTelefoneAtual = null;

function pluginsCapacitor() {
    return (window.Capacitor && window.Capacitor.Plugins) || {};
}

// ---------- Preferences (guarda o token no aparelho) ----------

async function salvarTokenLocal(token) {
    const { Preferences } = pluginsCapacitor();
    if (Preferences) {
        await Preferences.set({ key: CHAVE_TOKEN, value: token });
    } else {
        localStorage.setItem(CHAVE_TOKEN, token); // fallback pra testar num navegador comum
    }
}

async function lerTokenLocal() {
    const { Preferences } = pluginsCapacitor();
    if (Preferences) {
        const resultado = await Preferences.get({ key: CHAVE_TOKEN });
        return resultado.value;
    }
    return localStorage.getItem(CHAVE_TOKEN);
}

async function apagarTokenLocal() {
    const { Preferences } = pluginsCapacitor();
    if (Preferences) {
        await Preferences.remove({ key: CHAVE_TOKEN });
    } else {
        localStorage.removeItem(CHAVE_TOKEN);
    }
}

// ---------- Telas ----------

function mostrarTela(id) {
    ['tela-carregando', 'tela-login', 'tela-principal'].forEach(t => {
        document.getElementById(t).classList.toggle('hidden', t !== id);
    });
}

// ---------- Navegação principal (Entregas / Mapa / Ganhos / Perfil) ----------

let abaPrincipalAtual = 'entregas';

function mudarAbaPrincipal(aba) {
    abaPrincipalAtual = aba;
    ['entregas', 'mapa', 'ganhos', 'perfil'].forEach(a => {
        document.getElementById(`secao-${a}`).classList.toggle('hidden', a !== aba);
        const botao = document.getElementById(`nav-${a}`);
        botao.className = `flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 ${a === aba ? 'text-blue-700' : 'text-slate-400'}`;
    });
    if (aba === 'mapa') renderizarMapa();
    if (aba === 'ganhos') carregarGanhos();
    if (aba === 'perfil') carregarPerfil();
}

// ---------- Login ----------

async function fazerLogin() {
    const token = document.getElementById('input-token-login').value.trim();
    const erroEl = document.getElementById('erro-login');
    erroEl.classList.add('hidden');

    if (!token) {
        erroEl.textContent = 'Cole o código que a loja te enviou.';
        erroEl.classList.remove('hidden');
        return;
    }

    const botao = document.getElementById('botao-entrar');
    botao.disabled = true;
    botao.textContent = 'Entrando...';

    try {
        const resposta = await fetch(`${API_BASE}/motoboy_minhas_entregas.php?token=${encodeURIComponent(token)}`);
        const resultado = await resposta.json();

        if (resultado.status === 'sucesso') {
            await salvarTokenLocal(token);
            await iniciarAppLogado(token, resultado.motoboy_nome);
        } else {
            erroEl.textContent = resultado.mensagem || 'Código inválido.';
            erroEl.classList.remove('hidden');
        }
    } catch (e) {
        erroEl.textContent = 'Erro de conexão. Confira sua internet e tente de novo.';
        erroEl.classList.remove('hidden');
    } finally {
        botao.disabled = false;
        botao.textContent = 'Entrar';
    }
}

function sair() {
    if (!confirm('Sair e parar o rastreamento?')) return;
    pararRastreioGps();
    if (intervalAtualizarEntregas) clearInterval(intervalAtualizarEntregas);
    apagarTokenLocal();
    tokenAtual = null;
    document.getElementById('input-token-login').value = '';
    mostrarTela('tela-login');
}

// ---------- App logado ----------

async function iniciarAppLogado(token, nomeMotoboy) {
    tokenAtual = token;
    document.getElementById('nome-motoboy-header').textContent = nomeMotoboy || 'Entregador';
    mostrarTela('tela-principal');
    mudarAbaPrincipal('entregas');

    await iniciarRastreioGps();
    await carregarEntregas();

    // Atualiza a lista de entregas sozinha de tempos em tempos, pra
    // aparecer uma entrega nova sem precisar fechar e abrir o app.
    if (intervalAtualizarEntregas) clearInterval(intervalAtualizarEntregas);
    intervalAtualizarEntregas = setInterval(() => {
        carregarEntregas();
        if (abaPrincipalAtual === 'mapa') renderizarMapa();
    }, 30000);
}

// ---------- Formatação de pagamento (troco, crédito/débito, pago/a receber) ----------

const NOMES_FORMA_PAGAMENTO = {
    pix: 'Pix',
    cartao: 'Cartão',
    cartao_credito: 'Cartão de Crédito',
    cartao_debito: 'Cartão de Débito',
    cartao_online: 'Cartão Online',
    vale_refeicao: 'Vale-Refeição',
    dinheiro: 'Dinheiro',
    fiado: 'Fiado',
};

// Monta o texto+cor da forma de pagamento de uma entrega, incluindo:
// - se já foi pago (pix/cartão online) ou se o entregador precisa
//   cobrar na entrega
// - troco, quando for dinheiro e o cliente pediu troco de verdade
function montarInfoPagamento(entrega) {
    if (!entrega.forma_pagamento) {
        return '<span class="text-xs text-slate-400">Pagamento não informado</span>';
    }
    const nomeForma = NOMES_FORMA_PAGAMENTO[entrega.forma_pagamento] || entrega.forma_pagamento;

    if (entrega.ja_pago) {
        return `<span class="inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 border border-green-100 rounded-lg px-2 py-1">✅ ${escapeHtml(nomeForma)} · já pago</span>`;
    }

    if (entrega.forma_pagamento === 'dinheiro') {
        const valorPago = parseFloat(entrega.valor_pago || 0);
        const total = parseFloat(entrega.valor_total || 0);
        const troco = parseFloat(entrega.troco || 0);
        const trocoInfo = (valorPago > 0 && troco > 0)
            ? ` · troco para R$ ${fmtMoeda(valorPago)} (dar R$ ${fmtMoeda(troco)} de troco)`
            : (valorPago > 0 ? ' · sem troco' : '');
        return `<span class="inline-flex items-start gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1">💵 ${escapeHtml(nomeForma)} · cobrar R$ ${fmtMoeda(total)}${trocoInfo}</span>`;
    }

    // Cartão (crédito/débito específico se soubermos) e vale-refeição -
    // pagos na hora da entrega, o entregador só precisa saber a forma.
    return `<span class="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1">💳 ${escapeHtml(nomeForma)} · cobrar na entrega</span>`;
}

function fmtMoeda(v) {
    return parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

// ---------- Entregas ----------

let abaEntregasMotoboyAtual = 'ativas';

function mudarAbaEntregasMotoboy(aba) {
    abaEntregasMotoboyAtual = aba;
    const ativo = 'flex-1 py-2 rounded-lg text-sm font-semibold bg-blue-700 text-white';
    const inativo = 'flex-1 py-2 rounded-lg text-sm font-semibold bg-white border border-slate-200 text-slate-600';
    document.getElementById('aba-motoboy-ativas').className = aba === 'ativas' ? ativo : inativo;
    document.getElementById('aba-motoboy-historico').className = aba === 'historico' ? ativo : inativo;
    carregarEntregas();
}

async function carregarEntregas() {
    if (!tokenAtual) return;
    const lista = document.getElementById('lista-entregas');

    try {
        const historico = abaEntregasMotoboyAtual === 'historico' ? '&historico=1' : '';
        const resposta = await fetch(`${API_BASE}/motoboy_minhas_entregas.php?token=${encodeURIComponent(tokenAtual)}${historico}`);
        const resultado = await resposta.json();

        if (resultado.status !== 'sucesso') {
            lista.innerHTML = `<p class="text-center text-slate-400 py-10 text-sm">${escapeHtml(resultado.mensagem || 'Erro ao carregar entregas.')}</p>`;
            return;
        }

        ultimasEntregasCarregadas = resultado.entregas || [];
        if (resultado.motoboy_id) motoboyIdAtual = resultado.motoboy_id;
        if (resultado.motoboy_telefone) motoboyTelefoneAtual = resultado.motoboy_telefone;
        renderizarEntregas(ultimasEntregasCarregadas);
        if (abaPrincipalAtual === 'mapa') renderizarMapa();
        if (abaPrincipalAtual === 'perfil') carregarPerfil();
    } catch (e) {
        // Falha de rede isolada não precisa incomodar - só mantém a lista antiga na tela.
    }
}

function montarResumoItens(itens) {
    if (!itens || itens.length === 0) return '';
    return itens.map(i => `${parseFloat(i.quantidade)}x ${escapeHtml(i.nome)}`).join(', ');
}

function renderizarEntregas(entregas) {
    const lista = document.getElementById('lista-entregas');
    if (entregas.length === 0) {
        lista.innerHTML = abaEntregasMotoboyAtual === 'historico'
            ? '<p class="text-center text-slate-400 py-10 text-sm">Nenhuma entrega no histórico ainda.</p>'
            : '<p class="text-center text-slate-400 py-10 text-sm">Nenhuma entrega no momento. 🎉</p>';
        return;
    }

    if (abaEntregasMotoboyAtual === 'historico') {
        lista.innerHTML = entregas.map(e => {
            const naoAtendido = !!e.nao_atendido;
            const tagStatus = naoAtendido
                ? '<span class="bg-orange-50 text-orange-700 px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0">🚫 Não atendido</span>'
                : '<span class="bg-green-50 text-green-700 px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0">✓ Entregue</span>';
            return `
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                <div class="flex items-start justify-between gap-2">
                    <p class="font-bold text-slate-800">${escapeHtml(e.cliente_nome || 'Cliente')}</p>
                    ${tagStatus}
                </div>
                <p class="text-xs text-slate-400 mb-1">${e.data_venda ? new Date(e.data_venda.replace(' ', 'T')).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</p>
                <p class="text-sm text-slate-600 mb-1">📍 ${escapeHtml(e.endereco_entrega || 'Endereço não informado')}</p>
                <p class="text-xs text-slate-500 mb-2">${montarResumoItens(e.itens)}</p>
                ${naoAtendido && e.motivo_cancelamento ? `<p class="text-xs text-orange-700 bg-orange-50 border border-orange-100 rounded-lg px-2 py-1.5 mb-2">${escapeHtml(e.motivo_cancelamento)}</p>` : ''}
                <div class="flex items-center justify-between gap-2">
                    <span class="text-xs text-slate-400">Valor do pedido: R$ ${fmtMoeda(e.valor_total)}</span>
                    ${e.ganho_entrega != null ? `<span class="font-bold text-green-700">💰 R$ ${fmtMoeda(e.ganho_entrega)}</span>` : ''}
                </div>
            </div>`;
        }).join('');
        return;
    }

    lista.innerHTML = entregas.map(e => {
        const chegouLocal = e.status_entrega === 'chegou_local';
        const tagTopo = chegouLocal
            ? '<span class="bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0">⏳ Aguardando cliente</span>'
            : '<span class="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0">🛵 A caminho</span>';

        let acoesHtml;
        if (chegouLocal) {
            acoesHtml = `
                <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(e.endereco_entrega || '')}" target="_blank" class="bg-slate-100 text-slate-600 px-3 py-2.5 rounded-lg text-xs font-bold text-center">🗺️ Rota</a>
                <button onclick="marcarEntregue('${e.id}')" class="bg-green-600 hover:bg-green-700 text-white px-3 py-2.5 rounded-lg text-xs font-bold">✓ Entregue</button>
                <button onclick="marcarNaoAtendido('${e.id}')" class="border border-orange-300 text-orange-700 hover:bg-orange-50 px-3 py-2.5 rounded-lg text-xs font-bold">🚫 Não atendido</button>
            `;
        } else {
            acoesHtml = `
                <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(e.endereco_entrega || '')}" target="_blank" class="bg-slate-100 text-slate-600 px-3 py-2.5 rounded-lg text-xs font-bold text-center">🗺️ Rota</a>
                <button onclick="marcarChegueiNoLocal('${e.id}')" class="bg-blue-700 hover:bg-blue-800 text-white px-3 py-2.5 rounded-lg text-xs font-bold col-span-2">📍 Cheguei no local</button>
            `;
        }

        return `
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <div class="flex items-start justify-between gap-2 mb-1.5">
                <p class="font-bold text-slate-800">${escapeHtml(e.cliente_nome || 'Cliente')}</p>
                ${tagTopo}
            </div>
            <p class="text-xs text-slate-400 mb-1">${escapeHtml(e.cliente_telefone || '')}</p>
            <p class="text-sm text-slate-600 mb-1">📍 ${escapeHtml(e.endereco_entrega || 'Endereço não informado')}</p>
            <p class="text-xs text-slate-500 mb-2">🛍️ ${montarResumoItens(e.itens) || 'Itens não informados'}</p>
            <div class="mb-3">${montarInfoPagamento(e)}</div>
            ${chegouLocal ? '<p class="text-[11px] text-slate-400 mb-2">Se ninguém atender, registre como "Não atendido" - o horário e sua localização ficam salvos.</p>' : ''}
            <div class="flex items-center justify-between gap-2 mb-3">
                <span class="text-xs text-slate-400">Valor do pedido: R$ ${fmtMoeda(e.valor_total)}</span>
                ${e.ganho_entrega != null ? `<span class="font-bold text-green-700">💰 R$ ${fmtMoeda(e.ganho_entrega)}</span>` : ''}
            </div>
            <div class="grid grid-cols-2 gap-2">${acoesHtml}</div>
        </div>`;
    }).join('');
}

async function marcarChegueiNoLocal(vendaId) {
    try {
        const resposta = await fetch(`${API_BASE}/motoboy_marcar_chegou.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenAtual, venda_id: vendaId }),
        });
        const resultado = await resposta.json();
        if (resultado.status === 'sucesso') {
            carregarEntregas();
        } else {
            alert(resultado.mensagem || 'Não foi possível registrar sua chegada.');
        }
    } catch (e) {
        alert('Erro de conexão. Tente de novo.');
    }
}

async function marcarEntregue(vendaId) {
    if (!confirm('Confirmar que essa entrega foi feita?')) return;
    try {
        const resposta = await fetch(`${API_BASE}/motoboy_marcar_entregue.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenAtual, venda_id: vendaId }),
        });
        const resultado = await resposta.json();
        if (resultado.status === 'sucesso') {
            carregarEntregas();
        } else {
            alert(resultado.mensagem || 'Não foi possível marcar como entregue.');
        }
    } catch (e) {
        alert('Erro de conexão. Tente de novo.');
    }
}

async function marcarNaoAtendido(vendaId) {
    if (!confirm('Confirma que ninguém atendeu nesse endereço? O pedido vai ser cancelado - o horário e sua localização atual ficam registrados.')) return;
    try {
        const resposta = await fetch(`${API_BASE}/motoboy_marcar_nao_atendido.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenAtual, venda_id: vendaId }),
        });
        const resultado = await resposta.json();
        if (resultado.status === 'sucesso') {
            carregarEntregas();
        } else {
            alert(resultado.mensagem || 'Não foi possível registrar. Tente de novo.');
        }
    } catch (e) {
        alert('Erro de conexão. Tente de novo.');
    }
}

// ---------- Aba Mapa ----------
// Não temos uma chave de mapa (Google Maps/Mapbox) configurada ainda,
// então em vez de um mapa embutido "de mentirinha", cada entrega ativa
// mostra o endereço em destaque com um botão grande pra abrir a rota
// completa no Google Maps do aparelho (o mesmo link que já funciona no
// card da aba Entregas).

function renderizarMapa() {
    const lista = document.getElementById('lista-mapa');
    if (!lista) return;
    const ativas = ultimasEntregasCarregadas.filter(e => e.status_entrega === 'saiu_entrega' || e.status_entrega === 'chegou_local');

    if (abaEntregasMotoboyAtual !== undefined && ativas.length === 0) {
        lista.innerHTML = '<p class="text-center text-slate-400 py-10 text-sm">Nenhuma entrega ativa no momento.</p>';
        return;
    }

    lista.innerHTML = ativas.map(e => `
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <p class="font-bold text-slate-800 mb-1">${escapeHtml(e.cliente_nome || 'Cliente')}</p>
            <p class="text-sm text-slate-600 mb-3">📍 ${escapeHtml(e.endereco_entrega || 'Endereço não informado')}</p>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(e.endereco_entrega || '')}" target="_blank" class="block w-full text-center bg-blue-700 hover:bg-blue-800 text-white font-bold py-2.5 rounded-lg text-sm">🗺️ Abrir rota no Google Maps</a>
        </div>
    `).join('');
}

// ---------- Aba Ganhos ----------

async function carregarGanhos() {
    const bloco = document.getElementById('bloco-ganhos-conteudo');
    if (!tokenAtual || !bloco) return;
    bloco.innerHTML = '<p class="text-center text-slate-400 py-10 text-sm">Carregando...</p>';

    try {
        const resposta = await fetch(`${API_BASE}/motoboy_meus_ganhos.php?token=${encodeURIComponent(tokenAtual)}`);
        const resultado = await resposta.json();
        if (resultado.status !== 'sucesso') {
            bloco.innerHTML = `<p class="text-center text-slate-400 py-10 text-sm">${escapeHtml(resultado.mensagem || 'Erro ao carregar ganhos.')}</p>`;
            return;
        }
        renderizarGanhos(resultado);
    } catch (e) {
        bloco.innerHTML = '<p class="text-center text-slate-400 py-10 text-sm">Erro de conexão.</p>';
    }
}

function renderizarGanhos(dados) {
    const bloco = document.getElementById('bloco-ganhos-conteudo');
    const serie = dados.serie_7_dias || [];
    const maiorValor = Math.max(1, ...serie.map(d => d.ganho));
    const nomesDiaSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    const variacaoHtml = dados.variacao_percentual_ontem !== null && dados.variacao_percentual_ontem !== undefined
        ? `<span class="inline-flex items-center gap-1 text-xs font-bold ${dados.variacao_percentual_ontem >= 0 ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'} rounded-full px-2.5 py-1">${dados.variacao_percentual_ontem >= 0 ? '↗' : '↘'} ${dados.variacao_percentual_ontem}% em relação a ontem</span>`
        : '';

    const barrasHtml = serie.map(d => {
        const dataObj = new Date(d.dia + 'T00:00:00');
        const alturaPercentual = Math.max(4, Math.round((d.ganho / maiorValor) * 100));
        const hoje = d.dia === new Date().toISOString().slice(0, 10);
        return `
        <div class="flex-1 flex flex-col items-center gap-1">
            <span class="text-[10px] font-bold text-slate-500">${d.ganho > 0 ? 'R$ ' + fmtMoeda(d.ganho) : ''}</span>
            <div class="w-full flex items-end" style="height: 90px;">
                <div class="barra-ganho w-full rounded-t-md ${hoje ? 'bg-blue-700' : 'bg-blue-100'}" style="height: ${alturaPercentual}%;"></div>
            </div>
            <span class="text-[10px] text-slate-400">${nomesDiaSemana[dataObj.getDay()]}</span>
        </div>`;
    }).join('');

    bloco.innerHTML = `
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-4">
            <p class="text-sm text-slate-500 mb-1">Total do dia</p>
            <div class="flex items-center justify-between flex-wrap gap-2">
                <p class="text-3xl font-extrabold text-slate-800">R$ ${fmtMoeda(dados.total_hoje)}</p>
                ${variacaoHtml}
            </div>
            <p class="text-xs text-slate-400 mt-1">${dados.qtd_entregas_hoje} entrega(s) concluída(s)</p>
        </div>

        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-4">
            <p class="font-bold text-slate-700 mb-3">Ganhos dos últimos 7 dias</p>
            <div class="flex items-end gap-2">${barrasHtml}</div>
        </div>

        <div class="bg-white rounded-xl shadow-sm border border-slate-200 divide-y divide-slate-100">
            <div class="p-4 flex items-center justify-between">
                <span class="text-sm text-slate-600">Ticket médio por entrega</span>
                <span class="font-bold text-slate-800">R$ ${fmtMoeda(dados.ticket_medio)}</span>
            </div>
        </div>
    `;
}

// ---------- Aba Perfil ----------

function carregarPerfil() {
    if (!tokenAtual) return;
    // Reaproveita os dados que já vieram junto da última resposta de
    // entregas (nome, telefone, id) - não precisa de outra chamada.
    document.getElementById('perfil-nome').textContent = document.getElementById('nome-motoboy-header').textContent || '-';
    document.getElementById('perfil-telefone').textContent = motoboyTelefoneAtual || 'Telefone não cadastrado';
    document.getElementById('perfil-id').textContent = motoboyIdAtual ? `ID do entregador: ${motoboyIdAtual}` : '';
}

// ---------- Rastreio GPS em segundo plano ----------
// "backgroundMessage" preenchido faz o Android manter uma notificação
// fixa e continuar mandando localização mesmo com a tela apagada ou o
// app em segundo plano - é essa notificação que garante que o sistema
// operacional não mate o processo, diferente de um site/PWA comum.

async function iniciarRastreioGps() {
    const { BackgroundGeolocation } = pluginsCapacitor();
    if (!BackgroundGeolocation) {
        console.warn('Plugin de geolocalização não disponível (rodando fora do app nativo?).');
        return;
    }

    atualizarIndicadorGps('conectando');

    try {
        watcherIdGps = await BackgroundGeolocation.addWatcher(
            {
                backgroundTitle: 'VTR Entregador - Entrega em andamento',
                backgroundMessage: 'Compartilhando sua localização com a loja durante a entrega.',
                requestPermissions: true,
                distanceFilter: 15, // só manda atualização se andar uns 15m - economiza bateria/dados
            },
            (posicao, erro) => {
                if (erro) {
                    if (erro.code === 'NOT_AUTHORIZED') {
                        document.getElementById('aviso-permissao').classList.remove('hidden');
                        atualizarIndicadorGps('sem-permissao');
                    }
                    return;
                }
                document.getElementById('aviso-permissao').classList.add('hidden');
                atualizarIndicadorGps('ativo');
                if (posicao) {
                    enviarLocalizacaoServidor(posicao.latitude, posicao.longitude);
                }
            }
        );
    } catch (e) {
        console.error('Erro ao iniciar rastreio GPS:', e);
        atualizarIndicadorGps('erro');
    }
}

async function pararRastreioGps() {
    const { BackgroundGeolocation } = pluginsCapacitor();
    if (BackgroundGeolocation && watcherIdGps) {
        try { await BackgroundGeolocation.removeWatcher({ id: watcherIdGps }); } catch (e) { /* já parado */ }
        watcherIdGps = null;
    }
}

async function enviarLocalizacaoServidor(latitude, longitude) {
    if (!tokenAtual) return;
    try {
        await fetch(`${API_BASE}/atualizar_localizacao_motoboy.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenAtual, latitude, longitude }),
        });
    } catch (e) {
        // Falha isolada de rede não é grave - a próxima posição corrige sozinha.
    }
}

function atualizarIndicadorGps(estado) {
    const ponto = document.getElementById('ponto-gps');
    const texto = document.getElementById('texto-gps');
    const cores = {
        conectando: ['bg-slate-300', 'Conectando...'],
        ativo: ['bg-green-400', 'GPS ativo'],
        'sem-permissao': ['bg-red-400', 'Sem permissão'],
        erro: ['bg-red-400', 'Erro no GPS'],
    };
    const [cor, rotulo] = cores[estado] || cores.conectando;
    ponto.className = `w-2 h-2 rounded-full ${cor}`;
    texto.textContent = rotulo;
}

// ---------- Utilidade ----------

function escapeHtml(texto) {
    const div = document.createElement('div');
    div.textContent = texto ?? '';
    return div.innerHTML;
}

// ---------- Inicialização ----------

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('aviso-permissao').addEventListener('click', async () => {
        const { BackgroundGeolocation } = pluginsCapacitor();
        if (BackgroundGeolocation) await BackgroundGeolocation.openSettings();
    });

    const tokenSalvo = await lerTokenLocal();
    if (tokenSalvo) {
        try {
            const resposta = await fetch(`${API_BASE}/motoboy_minhas_entregas.php?token=${encodeURIComponent(tokenSalvo)}`);
            const resultado = await resposta.json();
            if (resultado.status === 'sucesso') {
                await iniciarAppLogado(tokenSalvo, resultado.motoboy_nome);
                return;
            }
        } catch (e) {
            // Sem internet no momento em que abriu o app - ainda assim entra
            // logado (o token já foi validado antes), só a lista de entregas
            // fica vazia até a conexão voltar.
            await iniciarAppLogado(tokenSalvo, '');
            return;
        }
        // Token salvo não é mais válido (motoboy desativado, etc.)
        await apagarTokenLocal();
    }
    mostrarTela('tela-login');
});
