# Mercado Pago Checkout Pro — modo de teste

Este documento é para revisão. A loja WG Multimarcas continua no ar com catálogo, pedido e WhatsApp. O pagamento online **não está ativo em produção** e esta alteração **não deve ser mergeada, publicada nem usada para cobrança real** até alguém revisar o código e o dono decidir o corte.

A recomendação é o **Checkout Pro**: o servidor cria a cobrança e o comprador paga no site do Mercado Pago. A loja não recebe número de cartão, CVV nem senha. Pix, cartão e parcelas ficam na tela do Mercado Pago, dentro do que a conta e o meio escolhido permitem.

## O que foi integrado

O site é um único servidor Node.js com Express (`server.js`), páginas em `public/` e Postgres (`DATABASE_URL`). Não há frontend separado em outro repositório. O pedido continua sendo gravado em `/api/orders`, com preço, quantidade, frete e total calculados no servidor. Em seguida, se o modo de teste estiver configurado, o servidor cria uma preferência do Checkout Pro ligada a esse pedido e devolve o link `sandbox_init_point`. O navegador redireciona o comprador. O WhatsApp permanece em todos os pontos de contato.

O retorno do Mercado Pago para a loja (`status=approved` na URL, por exemplo) **não marca o pedido como pago**. O servidor consulta a API do Mercado Pago, confere valor, moeda, referência, recebedor e se o pagamento é de teste, e só então atualiza Meus pedidos e o painel.

## Documentação oficial usada

- Visão do Checkout Pro: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/overview
- Criar aplicação: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/create-application
- Credenciais: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/credentials
- Contas de teste: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/test-accounts
- Compras de teste, cartões e Pix offline: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/integration-test/test-purchases
- Criar preferência: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/create-payment-preference
- URLs de retorno: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/configure-back-urls
- Excluir meios e parcelas: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-settings/payment-methods
- Webhooks e assinatura `x-signature`: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
- Webhooks do Checkout Pro: https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/notifications/webhooks
- Credenciais de teste automáticas (19/11/2025): https://www.mercadopago.com.br/developers/pt/news/2025/11/19/Streamlined-integration-testing-with-automatic-credentials
- Variáveis de ambiente no Render: https://render.com/docs/configure-environment-variables

A documentação atual do Mercado Pago também mostra o Checkout Pro via Orders API como caminho para recursos novos. A API de preferências continua documentada e suportada. Esta revisão implementa a preferência clássica do Checkout Pro, que é o fluxo pedido aqui (redirecionar o comprador e amarrar a cobrança ao pedido salvo). Não misture os dois fluxos na mesma aplicação sem uma revisão nova.

## Limitações do teste, conforme a documentação atual

- **Cartão:** use somente os cartões de teste publicados pelo Mercado Pago e uma conta compradora de teste, de preferência em janela anônima. O nome do titular muda o resultado. Exemplos oficiais: `APRO` aprova, `OTHE` recusa por erro geral, `CONT` deixa pendente, `INST` recusa por parcelas inválidas. A lista completa e os números fictícios estão na página de compras de teste. Não use cartão real. Não copie número de cartão real para este repositório, para o Render ou para o WhatsApp.
- **Parcelas:** o campo `payment_methods.installments` define o máximo oferecido. O padrão daqui é 12, que é o valor do exemplo oficial em código; o máximo aceito por esta loja é 12. Parcelas são de cartão. O nome `INST` serve para simular parcela inválida. Pix não tem parcela.
- **Pix:** no Checkout Pro, Pix é meio offline (`bank_transfer`). A documentação diz que um teste bem-sucedido de meio offline permanece **pendente**, porque o pagamento não se conclui dentro do sandbox. Não espere o Pix de teste virar `approved` sozinho. O teste de Pix que aprova com nome `APRO` e valor fixo pertence ao Checkout Transparente / Orders, e não a esta preferência.
- **Dinheiro em conta:** a documentação diz que esse meio não pode ser excluído. A tela do Mercado Pago pode mostrar saldo em conta além de Pix ou cartão.
- **Webhooks de teste:** a documentação avisa que pagamentos criados com credenciais de teste **não enviam notificação automática**. Dá para simular o webhook em Suas integrações. Enquanto isso, ao voltar do checkout a loja consulta `GET /v1/payments/search` no servidor. Os dois caminhos passam pela mesma validação.
- **Credenciais:** para aplicações novas de Checkout Pro, o Mercado Pago passou a entregar Access Token de teste automaticamente, com prefixo `APP_USR`. O prefixo antigo `TEST-` não é mais a regra. Por isso esta loja não decide o ambiente pelo prefixo. Teste e produção são separados por `MP_MODE`, `MP_ALLOW_PRODUCTION`, pelo link `sandbox_init_point` e pelo campo `live_mode` do pagamento.
- **URL local:** `notification_url` e `back_urls` não podem ser localhost. O webhook precisa de HTTPS público.

## Variáveis no servidor

Nenhuma delas pode ir para o frontend, para o Git ou para o log. `.env.example` só tem marcadores.

| Variável | Obrigatória para ligar o teste | Função |
| --- | --- | --- |
| `MP_ACCESS_TOKEN` | sim | Access Token de **teste**. Só no servidor. |
| `MP_WEBHOOK_SECRET` | sim | Segredo de assinatura gerado em Webhooks da aplicação. |
| `APP_BASE_URL` | sim | URL pública HTTPS, sem barra no final. Ex.: `https://wg-loja-render.onrender.com` |
| `MP_MODE` | não | Padrão `test`. Use `production` só no corte revisado. |
| `MP_ALLOW_PRODUCTION` | não | Precisa ser exatamente `true` junto com `MP_MODE=production`. Qualquer outro valor mantém a produção desligada. |
| `MP_MAX_INSTALLMENTS` | não | Máximo de parcelas no cartão, de 1 a 12. Padrão 12. |
| `MP_WEBHOOK_TOLERANCE_SECONDS` | não | Janela anti-replay do `ts`, de 30 a 3600. Padrão 300. |
| `MP_COLLECTOR_ID` | não | Se preenchido, a preferência e o pagamento precisam ser deste recebedor. |

Se faltar token, segredo ou URL, ou se a produção estiver sem a trava, o Mercado Pago fica desligado. O catálogo, o frete, o pedido e o WhatsApp continuam. O processo não cai por causa disso.

As variáveis que já existiam continuam necessárias para o servidor subir: `DATABASE_URL`, `JWT_SECRET` (24 caracteres ou mais) e `ADMIN_PASSWORD`. Também são usadas `WHATSAPP`, `PIX_KEY`, `CORS_ORIGIN`, `STORE_LOGIN_NAME` e `PORT`.

## Como colocar as variáveis no Render

Isto descreve o painel. **Não altere o serviço agora.** Só faça isso depois que o pull request for revisado e alguém decidir publicar.

Pela documentação atual do Render (Environment Variables and Secrets):

1. Abra o [painel do Render](https://dashboard.render.com/), selecione o web service da loja.
2. Em **Environment**, clique em **Add Environment Variable** (ou **Add from .env** para colar várias de uma vez).
3. Informe a chave e o valor. O valor do token e do segredo fica só nesse campo.
4. Ao salvar, o Render oferece três opções: **Save, rebuild, and deploy** (build novo e publicação), **Save and deploy** (publica o build que já existe com as variáveis novas) e **Save only** (grava e não publica; a loja só passa a ver o valor no próximo deploy).
5. Enquanto esta revisão não for publicada de propósito, não use uma opção que faça deploy.
6. Não use arquivo secreto nem variável de build para o token. O token só é necessário com o processo no ar.
7. O Render já define `PORT` e `RENDER_EXTERNAL_URL`. Mesmo assim, defina `APP_BASE_URL` com a URL pública que deve receber o comprador e o webhook, para o endereço não mudar por engano.

O serviço atual informado é `https://wg-loja-render.onrender.com/`. Confirme no painel se esse hostname ainda é o do web service antes de gravar `APP_BASE_URL`.

## URL de notificação

Com `APP_BASE_URL=https://wg-loja-render.onrender.com`, cadastre no Mercado Pago, em Suas integrações → Webhooks:

`https://wg-loja-render.onrender.com/api/payments/webhook?source_news=webhooks`

O parâmetro `source_news=webhooks` é o que a documentação pede para receber webhook e não IPN. Ative o evento de pagamento (`payment`). Guarde o segredo gerado em `MP_WEBHOOK_SECRET`. A documentação diz que esse segredo não vence sozinho; a troca periódica é recomendada, não obrigatória.

A mesma URL é enviada em `notification_url` na preferência. O servidor exige o header `x-signature` no formato `ts=...,v1=...`, monta o manifesto `id:{data.id};request-id:{x-request-id};ts:{ts};` (sem o par que vier vazio), calcula HMAC-SHA256 em hexadecimal e compara em tempo constante. Há uma divergência entre o texto público, que manda converter `data.id` para minúsculas, e o SDK oficial Node, que em junho de 2026 passou a preservar a caixa porque o Mercado Pago assina o valor original. A loja aceita a assinatura do valor exato e, se ela não bater, a do valor em minúsculas; a consulta à API usa o identificador que realmente assinou. Timestamps de 10 dígitos são segundos; os de 13 dígitos, milissegundos. Fora da janela, a notificação é recusada. O mesmo `x-request-id` com outro `data.id` também é recusado.

O corpo do webhook e a URL de retorno não definem o status. O servidor busca `GET /v1/payments/{id}` ou, no tópico `merchant_order`, busca a ordem e em seguida cada pagamento. Confere `external_reference` (`wg-order-{id}`), `BRL`, o total do pedido, `collector_id`, `live_mode` (precisa ser falso no teste e verdadeiro na produção) e, se vier, a preferência. `approved` vira Pago. `pending`, `in_process`, `in_mediation` e `authorized` viram Pendente. `rejected` vira Recusado e o estoque continua reservado, porque o comprador pode tentar de novo. `cancelled` vira Cancelado. `refunded` vira Reembolsado. `charged_back` vira Contestado. Reembolso parcial vira Parcialmente reembolsado. Cancelamento, reembolso total e contestação devolvem o estoque uma única vez, desde que o pedido ainda não esteja em separação, envio ou entrega. Notificação repetida não devolve o estoque de novo. Um pagamento pendente ou recusado que chegue depois de um pago não desfaz o pago.

## Fluxo de teste com vendedor e comprador

1. Crie a conta do Mercado Pago em https://www.mercadopago.com.br/hub/registration/landing se ainda não existir.
2. Em https://www.mercadopago.com.br/developers/panel/app crie uma aplicação de Checkout Pro. Pela regra nova, o Access Token e a Public Key de teste aparecem na hora. Use só o token de teste.
3. Crie um usuário comprador de teste em Suas integrações → Contas de teste. A documentação pede conta de vendedor (a sua, dona da aplicação) e conta de comprador. O login de teste não acessa a área de credenciais; isso é esperado.
4. Cadastre no Render, somente quando for a hora de publicar esta revisão, as variáveis de teste. Deixe `MP_MODE=test` e `MP_ALLOW_PRODUCTION=false`.
5. Cadastre a URL de notificação e copie o segredo para `MP_WEBHOOK_SECRET`.
6. Abra a loja em uma janela anônima. A faixa amarela deve dizer que é modo de teste.
7. Faça um pedido com cartão de teste e titular `APRO`. O navegador vai para `sandbox.mercadopago.com.br`. Entre com o comprador de teste. Não use cartão real.
8. Ao voltar, Meus pedidos e o painel devem mostrar Pago só depois que o servidor consultar o Mercado Pago. Se a página voltar com `status=approved` mas a API ainda não tiver o pagamento, o pedido não pode aparecer como Pago.
9. Repita com titular `OTHE` e confira Recusado, sem estoque devolvido.
10. Faça um pedido Pix. O status esperado no sandbox é Pendente, não Pago.
11. No painel do Mercado Pago, simule uma notificação de webhook. Uma assinatura errada precisa receber HTTP 401 e não pode mudar o pedido.
12. O botão de WhatsApp continua no produto, no pedido e no retorno.

## Checklist de teste

- [ ] Catálogo abre com as variáveis do Mercado Pago vazias.
- [ ] Pedido sem Mercado Pago configurado ainda oferece WhatsApp.
- [ ] O total cobrado ignora preço, frete e total enviados pelo navegador.
- [ ] O link de teste é o `sandbox_init_point`, nunca o `init_point`.
- [ ] Pix de teste fica pendente.
- [ ] Cartão `APRO` fica pago só após a consulta ao provedor.
- [ ] Cartão `OTHE` fica recusado.
- [ ] Voltar do checkout com `status=approved` na URL, sem pagamento confirmado na API, não marca Pago.
- [ ] Webhook com assinatura inválida recebe 401.
- [ ] Pagamento com outro valor, outra referência, `live_mode=true` ou outro recebedor não marca Pago.
- [ ] A mesma notificação ou o mesmo pagamento aprovado duas vezes não baixa o estoque duas vezes.
- [ ] Reembolso marca Reembolsado e devolve o estoque uma vez.
- [ ] Um cliente não vê o pedido de outro. Visitante sem a chave do próprio pedido recebe 404.
- [ ] O token e o segredo não aparecem no HTML, no JavaScript, no Git nem na resposta da API.
- [ ] `MP_MODE=production` sem `MP_ALLOW_PRODUCTION=true` não cria preferência.

## Corte para produção — só depois de revisão

Não faça estes passos como parte desta revisão.

1. Revisar o diff e os testes com o responsável pela loja.
2. Publicar o código de propósito, em um deploy separado do teste.
3. Na aplicação do Mercado Pago, obter as credenciais de **produção** e trocar o Access Token no Render. Apagar o token de teste do ambiente de produção.
4. Gerar ou confirmar o segredo de webhook de produção e a URL HTTPS.
5. Definir `MP_MODE=production` e `MP_ALLOW_PRODUCTION=true` no mesmo momento, ciente de que isso passa a criar `init_point` e a aceitar apenas pagamento com `live_mode=true`.
6. Fazer uma compra real de valor baixo, com cartão ou Pix real, e conferir Pago no painel. O Pix real, fora do sandbox, pode ser aprovado de verdade; o Pix de teste não serve como prova de produção.
7. Confirmar que o WhatsApp segue visível e que nenhum segredo foi impresso nos logs do Render.

## Rollback

1. No Render, apague `MP_ACCESS_TOKEN` ou defina `MP_ALLOW_PRODUCTION=false` e `MP_MODE=test`. Salve **sem** publicar se o código novo ainda não deve continuar no ar; se o código novo já estiver publicado e a meta for desligar a cobrança na hora, use **Save and deploy**.
2. Com as variáveis ausentes ou com a produção bloqueada, a loja volta a registrar o pedido e a combinar pelo WhatsApp. O catálogo não depende do Mercado Pago.
3. Se precisar remover o código, volte o deploy para o commit anterior. As colunas novas no Postgres podem ficar; o código antigo não as usa.
4. Não apague pedidos já gravados. Estoque devolvido por cancelamento ou reembolso não é desfeito pelo rollback.
5. No Mercado Pago, desative a URL de notificação se o servidor antigo for ficar no ar, para ele não receber POST que não sabe validar.

## O que os testes automáticos cobriram

O comando `npm test` exercita, sem rede e sem credencial real: adulteração de preço, frete e quantidade; assinatura inválida, prazo vencido e `data.id` malformado; valor, referência, `live_mode` e requisição repetida; pendente versus aprovado; reembolso e estoque; acesso de outro cliente, visitante e admin; produção bloqueada; catálogo com Mercado Pago desligado.

Não houve compra ponta a ponta no sandbox nem no site do Render. Sem o Access Token de teste do dono, não dá para abrir o checkout real, aprovar um cartão de teste nem receber um webhook verdadeiro do Mercado Pago. Em um Chrome local, com o provedor simulado, a vitrine mostrou a faixa de teste, gravou o pedido e redirecionou para `https://sandbox.mercadopago.com.br`. Isso não substitui um pagamento de teste com as credenciais do dono.
