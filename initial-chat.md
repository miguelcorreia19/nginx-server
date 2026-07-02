Quero que me ajudes a criar prompts, em Inglês, para um agente de coding implementar/fixar problemas no meu projeto.

O meu flow preferido é:

1. Eu descrevo o problema.
2. Tu geras primeiro uma prompt de análise para o agente.
   - O agente deve analisar o código relacionado.
   - Não deve implementar ainda.
   - Deve encontrar root cause, arquitetura existente, padrões, ficheiros relevantes, riscos e opções.
   - Deve devolver um relatório estruturado.
3. Depois eu colo aqui o relatório do agente.
4. Tu ajudas-me a avaliar o relatório.
5. Só depois geras uma segunda prompt de implementação.
   - Deve ter scope claro.
   - Deve seguir padrões existentes.
   - Deve evitar overengineering.
   - Deve incluir edge cases.
   - Deve incluir testes.
   - Deve incluir comandos a correr.
   - Deve incluir uma secção “After implementation” bem detalhada.

Características que quero nas prompts:

- O agente deve analisar o projeto antes de mexer.
- Não deve inventar arquitetura nova se já existir padrão.
- Deve reutilizar serviços, repositories, jobs, queues, websocket, auth, seeds e testes existentes.
- Deve identificar root cause antes de implementar.
- Deve distinguir bugs reais, dados inconsistentes, comportamento esperado e problemas fora de scope.
- Deve evitar hardcoding de roles, nomes, permissões ou entidades, salvo se o projeto já fizer isso.
- Deve respeitar sysadmin como flag/bypass no User, não como role.
- Para users não-sysadmin, roles/permissões dinâmicas mandam.
- Deve tratar soft-delete + unique keys com cuidado.
- Deve evitar N+1.
- Deve normalizar IDs antes de comparar.
- Deve garantir que side effects só acontecem depois da operação principal persistir.
- Deve adicionar testes de regressão.
- Deve reportar claramente o que foi alterado e o que ficou fora de scope.

Formato que quero:

Primeiro, quando eu descrever o problema, responde com:

A) Prompt de análise para o agente

Essa prompt deve conter:

- Contexto
- Problema observado
- Objetivo da análise
- O que analisar
- O que não fazer
- Perguntas que o agente deve responder
- Output esperado do agente
- Proibição explícita de implementar nesta fase

Depois, quando eu trouxer o relatório do agente, responde com:

B) Avaliação do relatório

- O que está correto
- O que parece risco
- O que falta confirmar
- Qual opção escolher, se houver várias

C) Prompt de implementação
Com:

- Contexto
- Objetivo
- Scope
- Requisitos
- Edge cases
- Testes obrigatórios
- Comandos a correr
- After implementation report

Na secção “After implementation”, quero sempre pedir:

1. Exact root cause.
2. Exact files changed.
3. Whether the bug was caused by data, relation metadata, seed, authorization, duplicated logic, stale data, soft-delete, ID normalization, or another issue.
4. Final behavior/rules.
5. Endpoints affected, if any.
6. Confirmation that existing architecture/patterns were preserved.
7. Confirmation that no unrelated behavior was changed.
8. Tests added/updated.
9. Commands run and results.
10. Remaining risks, assumptions, deferred items, or follow-up tasks.

Quando eu disser o problema, começa por gerar só a prompt de análise. Não saltes diretamente para implementação.

O problema:
Eu criei este projeto para Dockerized Multi-Domain Nginx Server with HTTP/HTTPS Modes

Analisa e ve o que dá para melhorar

Quero fazer um refactoring ao código, para melhorar a performance, corrigir erros e bugs

Para tu teres uma noção, o projeto é este: https://github.com/miguelcorreia19/nginx-server
Está público