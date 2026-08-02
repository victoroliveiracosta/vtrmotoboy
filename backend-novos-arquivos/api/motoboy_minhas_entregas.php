<?php
require_once __DIR__ . '/../config/db.php';

header('Content-Type: application/json; charset=utf-8');

$token = trim($_GET['token'] ?? '');
if ($token === '') {
    http_response_code(400);
    echo json_encode(['status' => 'erro', 'mensagem' => 'Token não informado.']);
    exit;
}

$pdo = getPDO();

try {
    $stmtMotoboy = $pdo->prepare("SELECT id, tenant_id, nome FROM motoboys WHERE token_rastreio = ? AND ativo = 1");
    $stmtMotoboy->execute([$token]);
    $motoboy = $stmtMotoboy->fetch();
} catch (\Throwable $e) {
    http_response_code(500);
    echo json_encode(['status' => 'erro', 'mensagem' => 'Rode sql/adicionar_gps_motoboy.sql antes de usar essa função.']);
    exit;
}

if (!$motoboy) {
    http_response_code(404);
    echo json_encode(['status' => 'erro', 'mensagem' => 'Token inválido ou motoboy desativado.']);
    exit;
}

try {
    // Entregas ainda em aberto atribuídas a esse motoboy - tanto vendas
    // normais do balcão quanto Pedido Online (que vira venda de verdade
    // igual qualquer outra assim que o pedido é concluído).
    $stmt = $pdo->prepare(
        "SELECT v.id, v.valor_total, v.endereco_entrega, v.status_entrega, v.data_venda,
                c.nome AS cliente_nome, c.telefone AS cliente_telefone
         FROM vendas_nuvem v
         LEFT JOIN clientes c ON c.id = v.cliente_id AND v.cliente_id != 'cliente-balcao'
         WHERE v.tenant_id = ? AND v.motoboy_id = ? AND v.status_entrega = 'saiu_entrega'
         ORDER BY v.data_venda ASC"
    );
    $stmt->execute([$motoboy['tenant_id'], $motoboy['id']]);
    $entregas = $stmt->fetchAll();
} catch (\Throwable $e) {
    http_response_code(500);
    echo json_encode(['status' => 'erro', 'mensagem' => 'Rode as migrações de entrega antes de usar essa função.']);
    exit;
}

echo json_encode(['status' => 'sucesso', 'motoboy_nome' => $motoboy['nome'], 'entregas' => $entregas]);
