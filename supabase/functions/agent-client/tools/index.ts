/**
 * # Tools
 *
 * ## Simple tools
 *
 * - Functions
 *
 *   Do not require configuration.
 *
 *   - Utils like calculator, calendar.
 *   - Core function like handle_conversation.
 *
 * - MCP
 *
 *   External tools. The tools do not require config, the MCP server does.
 *
 * ## Special tools
 *
 * - HTTP
 * - SQL
 * - Agent
 *
 *   Use an agent as tool. The conversation returns to the agent which made the call.
 */

import { HTTPTools } from "./http.ts";
import { SQLTools } from "./sql.ts";
import { CalculatorTool } from "./calculator.ts";
import { TransferToHumanAgentTool } from "./handoff.ts";
import {
  BookAppointmentTool,
  CancelAppointmentTool,
  ListAppointmentsTool,
  RescheduleAppointmentTool,
} from "./appointments.ts";

// Only what is registered here reaches an agent. `attachment.ts` and `code.ts`
// also live in this folder and are deliberately absent: both are skeletons, and
// a tool that returns its own input would look like a feature while doing
// nothing. See crm-whatsapp-api#27. - 2026/08/01
const FunctionTools = [
  CalculatorTool,
  TransferToHumanAgentTool,
  // As três da agenda andam juntas: quem pode marcar precisa poder consultar
  // antes e desmarcar depois. Sem esta linha o interruptor da tela liga uma
  // ferramenta que não existe aqui, e o agente responde "Tool
  // list_appointments not found" a cada pedido — foi assim que a primeira
  // simulação as pegou faltando. - 2026/08/02
  ListAppointmentsTool,
  BookAppointmentTool,
  RescheduleAppointmentTool,
  CancelAppointmentTool,
];
const CustomTools: unknown[] = [];

export const Toolbox = {
  function: FunctionTools,
  custom: CustomTools,
  http: HTTPTools,
  sql: SQLTools,
};
