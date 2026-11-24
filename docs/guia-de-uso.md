# Guía de uso de pstack en GitHub Copilot

Referencia rápida para saber qué comando usar en cada situación. Todos se escriben en el chat de Copilot (VS Code o CLI) con una barra, como `/tdd`.

## Antes de empezar

1. **Comprueba la máquina:** `pstack doctor`. Avisa de lo que falta.
   - `gh` (GitHub CLI) hace falta para los playbooks de PR, `/why` y `/recall`. Instálalo y ejecuta `gh auth login`.
   - `mise` y Java 11 o superior solo hacen falta para `/statechart` y la verificación formal.
2. **Elige modelos:** en un chat nuevo, `/setup-pstack`. Pregunta un presupuesto (large, medium, small) y un modelo por rol. Sin hacerlo, los roles usan Opus 5.5. Sin interacción: `pstack models init --budget medium`.
3. **Abre un chat nuevo** después de instalar o actualizar: las skills se cargan al empezar la conversación.

## Cuándo no se activa

pstack no cambia el comportamiento normal del agente. Todas las skills, salvo `/setup-pstack`, solo se ejecutan si las escribes. Si haces una pregunta normal, el agente responde como siempre y las instrucciones de cada repo siguen mandando. La única excepción es el agente **poteto-mode** del selector de agentes, que se carga en cada turno.

## Qué comando usar

### Entender código
| Comando | Para qué |
|---|---|
| `/how` | Explica cómo funciona un subsistema, o dónde debería vivir algo nuevo. |
| `/why` | Cuenta por qué se hizo así, mirando commits y PRs. Necesita `gh`. |
| `/teach` | Lo anterior en una explicación didáctica, con diagramas. |
| `/recall` | Reconstruye tu contexto reciente de un tema a partir de tus chats anteriores. |
| `/blast-radius` | Qué puede romper un cambio pequeño, con una prueba de por qué es seguro. |

### Diseñar y decidir
| Comando | Para qué |
|---|---|
| `/architect` | Fija tipos, firmas y módulos antes de escribir código. |
| `/arena` | Varios modelos hacen lo mismo en paralelo y se combina lo mejor. |
| `/interrogate` | Modelos distintos intentan romper un cambio. Solo valen los fallos que se reproducen. |
| `/swarm` | Reparte el trabajo en paralelo, uno por paquete o rama, y devuelve un informe. |

### Escribir código
| Comando | Para qué |
|---|---|
| `/tdd` | Arregla un bug con un test que falla primero. |
| `/typescript-best-practices` | Reglas de TypeScript al editar `.ts` o `.tsx`. |
| `/no-comments` | Un revisor borra comentarios sobrantes y marca código que debería explicarse solo. |
| `/benchmark-checklist` | Revisa una medida de rendimiento antes de fiarte de ella. |
| `/correct` | Si repites las mismas correcciones al agente, las convierte en tests o lint. |

### Escribir y explicar
| Comando | Para qué |
|---|---|
| `/unslop` | Quita el estilo típico de IA de un texto. |
| `/technical-writing` | Estándar para documentación, PRs y commits. |
| `/bro` | Repite el último mensaje en lenguaje llano. |
| `/in-your-own-words` | El agente reformula tu objetivo para comprobar que lo entendió. |
| `/sharpen` | Reescribe tu prompt para que pida algo más profundo. |
| `/reframe` | Te da los términos técnicos de lo que describes con palabras vagas. |
| `/ketchup` | Te pone al día de lo que cambió en el chat desde tu último mensaje. |

### Tareas grandes y de proceso
| Comando | Para qué |
|---|---|
| `/poteto-mode` | Punto de entrada para cualquier tarea que necesite rigor. Elige el playbook, abre la lista de tareas, delega y verifica. |
| `/figure-it-out` | Diseña un plan auditable cuando ningún playbook encaja. |
| `/show-me-your-work` | Registra las decisiones de una tarea larga para revisarlas después. |
| `/create-verification-skill` | Crea la skill que lanza y prueba tu app. |
| `/maintain-verification-skill` | La mantiene al día cuando cambia la app. |

### Configuración y mejora
| Comando | Para qué |
|---|---|
| `/setup-pstack` | Elige modelos por rol y presupuesto. |
| `/poteto-help` | Te dice qué comando usar. |
| `/automate-me` | Crea tu propia skill `<nombre>-mode` a partir de tus hábitos. |
| `/reflect` | Convierte lo aprendido en una sesión en cambios de skills. |
| `/create-skill` | Ayuda a crear una skill nueva. |

### Especializadas
`/statechart`, `/create-formal-verification-skill` y `/maintain-formal-verification-skill` sirven para modelos formales (TLA+) y necesitan `mise` y Java 11 o superior. `/ketchup-video` necesita un renderizador de vídeo. `/make-bot-ui` no funciona en Copilot.

### Principios
`/principle-<nombre>` carga una regla corta, por ejemplo `/principle-prove-it-works`. Casi nunca los llamas tú: `/poteto-mode` los consulta. También sirven en una instrucción, por ejemplo "aplica prove it works y enséñame la salida real".

## Usar `/poteto-mode`

Escribe el objetivo y cómo sabrás que está hecho:

```
/poteto-mode el login redirige mal tras expirar la sesión. reproduce primero, corrige y verifica con el flujo real.
```

- **Mantenerlo activo en todos los turnos:** selecciona el agente **poteto-mode** en el selector de agentes del chat.
- **Tarea nueva en la misma conversación:** escribe "new task".
- **Modelo del chat:** en las pruebas, con Claude Opus 5.5 siguió todos los pasos y con Sonnet 5.5 se saltó el playbook, la lista de tareas y la delegación. Es una muestra pequeña, no una regla. Para el resto de comandos, Sonnet funcionó bien.

## Probar la app en local

Los playbooks piden verificar sobre la app real. Para que el agente la abra y la pruebe sin que la reproduzcas tú:

1. Ejecuta una vez por repo `/create-verification-skill`. Crea `.github/skills/verify-<app>/`, con cómo arrancar la app, cómo manejarla y dónde guardar capturas.
2. Revisa lo que genera antes de commitearlo.
3. Después, `/poteto-mode` o `/tdd` la usarán solos.

Requisitos: la app debe arrancar en tu máquina, y si pide login o datos tendrás que indicárselos. Sin esa skill, el agente usa las herramientas de navegador de VS Code o Playwright. No se ha probado con una app web real.

## Tareas largas

Pide siempre un criterio comprobable ("hasta que los tests pasen"), no una duración. Copilot trae `/loop` y `/every`, pero el control de extremo a extremo no está validado: vigila el trabajo.

## Convenciones de cada repo

pstack no conoce las reglas de tus repos (idioma, formato de commits, i18n). Díselas en el prompt o comprueba que se respetan.

## Lo que no funciona o no está probado

- Playbooks de PR (`babysit`, `shipping`, `opening-a-pr`): necesitan `gh`.
- `/loop` de extremo a extremo.
- `/make-bot-ui`, Bugbot, agentes en la nube y el plugin `cursor-team-kit`.
- `/setup-pstack` interactivo y el agente `poteto-mode`.

Detalle completo: [limitations.md](limitations.md) y [COMPATIBILITY.md](../pstack-copilot/docs/COMPATIBILITY.md).

## Mantenerlo al día

- `pstack update` sincroniza upstream, valida e instala. Revisa `git diff` después.
- Un workflow diario abre un PR cuando upstream cambia. Ver [upstream-sync.md](upstream-sync.md).
- `pstack rollback` vuelve a la versión anterior instalada.
- `pstack doctor` diagnostica la instalación.
