# radar_vagas — plugin nativo do Hermes

Plugin Python (`plugin.yaml` + `__init__.py` com `register(ctx)`) que leva ao Radar de Vagas as respostas do Telegram às perguntas humanas, sem que essas mensagens passem pelo LLM.

## O que faz

- Registra o hook `pre_gateway_dispatch`, que roda para cada mensagem recebida antes da autorização e do despacho para o agente.
- Age só quando a plataforma é `telegram` e o `user_id` está em `RADAR_ANSWER_ALLOWED_USERS` ou, na falta dela, em `TELEGRAM_ALLOWED_USERS`. Sem nenhuma das duas listas, nada é consumido (`*` não vale como lista).
- Consome a mensagem (`{"action": "skip"}`) apenas quando ela é:
  - `/radar responder <código> <texto>`, `/radar pular <código>` ou `/radar parar <código>`; ou
  - um **reply** a uma mensagem de pergunta enviada pelo Radar. O id respondido é comparado com `<RADAR_APP_DIR>/.radar/telegram-refs.json`, arquivo gravado por `scripts/ops/notify-human-questions.mjs`.
- Todo o resto segue para a conversa normal do Hermes. Isso inclui texto livre como "sim" ou "cancelar".
- Executa `node <RADAR_APP_DIR>/scripts/ops/answer-human-questions.mjs --stdin-json` com argv em lista, sem shell e com timeout de 30 s. Pelo stdin passa `{platform, chat_id, user_id, message_id, reply_to_message_id, text}`.
- Responde em reply ao usuário com `gateway.adapters[platform].send(chat_id, texto, reply_to=message_id)`. Se não houver adapter, devolve `{"action": "rewrite"}` com um aviso curto de sistema, e o agente apenas repassa o resultado.
- Registra `/radar` com `ctx.register_command` só como ajuda. Sozinho, o comando não registra nada, porque o handler recebe apenas os argumentos, sem remetente nem `message_id`.
- Qualquer exceção é capturada e vai para o log. O gateway nunca cai por causa do plugin.

## Instalação (container oficial, `HERMES_HOME=/opt/data`)

```sh
mkdir -p /opt/data/plugins
cp -r /opt/data/dashboard/busca_emprego/hermes/native-plugin/radar_vagas /opt/data/plugins/radar_vagas
hermes plugins enable radar_vagas      # adiciona a plugins.enabled no config.yaml
# reinicie o gateway para carregar o plugin
```

Variáveis lidas do ambiente do gateway (`/opt/data/.env`):

| Variável | Uso |
| --- | --- |
| `TELEGRAM_ALLOWED_USERS` | allowlist oficial do Hermes (user ids separados por vírgula) |
| `RADAR_ANSWER_ALLOWED_USERS` | allowlist própria do Radar; tem precedência quando definida |
| `RADAR_APP_DIR` | raiz do Radar (padrão `/opt/data/dashboard/busca_emprego`) |
| `RADAR_NODE_BIN` | binário do Node (padrão: `node` do PATH) |
| `RADAR_TELEGRAM_REFS_PATH` | caminho alternativo do `telegram-refs.json` |

O script de resposta usa `RADAR_INTERNAL_SERVICE_TOKEN` e `PORT` do ambiente do gateway (o `.env` do Hermes); só lê o `.env.local` do Radar quando o ambiente não os traz. Com o dashboard isolado em outro usuário Unix (`docs/security.md`), o `.env.local` fica ilegível para o Hermes: defina as duas chaves no `.env` do Hermes. O token de serviço não alcança os portões humanos (interesse, `APROVO`, `AUTORIZO`).

## Testes

```sh
python3 -m unittest discover -s hermes/native-plugin
```

## Limitações

- O nome do campo de reply no `MessageEvent` (`reply_to_message_id`) aparece na documentação apenas como "reply-context fields", sem tabela de campos. O plugin lê o atributo com `getattr` e, se ele faltar, só o comando explícito funciona.
- Reinstale o plugin, copiando o diretório de novo, sempre que atualizar o repositório.
