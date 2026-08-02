<?php
require_once __DIR__ . '/../config/db.php';

header('Content-Type: application/json; charset=utf-8');

$dados = json_decode(file_get_contents('php://input'), true);
$token = trim($dados['token'] ?? '');
$vendaId = trim($dados['venda_id'] ?? '');

if ($token === '' || $vendaId === '') {
    http_response_code(400);
    echo json_encode(['status' => 'erro', 'mensagem' => 'Dados incompletos.']);
    exit;
}

$pdo = getPDO();

try {
    $stmtMotoboy = $pdo->prepare("SELECT id, tenant_id FROM motoboys WHERE token_rastreio = ? AND ativo = 1");
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
    // Só marca como entregue se essa venda for realmente desse motoboy -
    // nunca deixa um token conseguir mexer na entrega de outro motoboy.
    $stmt = $pdo->prepare(
        "UPDATE vendas_nuvem SET status_entrega = 'entregue' WHERE id = ? AND tenant_id = ? AND motoboy_id = ?"
    );
    $stmt->execute([$vendaId, $motoboy['tenant_id'], $motoboy['id']]);

    if ($stmt->rowCount() === 0) {
        http_response_code(404);
        echo json_encode(['status' => 'erro', 'mensagem' => 'Entrega não encontrada pra esse motoboy.']);
        exit;
    }
} catch (\Throwable $e) {
    http_response_code(500);
    echo json_encode(['status' => 'erro', 'mensagem' => 'Rode as migrações de entrega antes de usar essa função.']);
    exit;
}

echo json_encode(['status' => 'sucesso']);
