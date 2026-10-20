// S1 extra: DBOS's class decorators (legacy TS decorators) under Bun's TS transpiler.
import { DBOS } from '@dbos-inc/dbos-sdk';

class Greeter {
  @DBOS.step()
  static async greet(name: string) { return `hello ${name}`; }

  @DBOS.workflow()
  static async run(name: string) {
    const g = await Greeter.greet(name);
    await DBOS.setEvent('greeting', g);
    return g;
  }
}

DBOS.setConfig({ name: 's1-deco', systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL });
await DBOS.launch();
const h = await DBOS.startWorkflow(Greeter).run('bun');
console.log('result:', await h.getResult(), '| event:', await DBOS.getEvent(h.workflowID, 'greeting'));
console.log('steps:', (await DBOS.listWorkflowSteps(h.workflowID))?.map((s) => s.name).join(', '));
await DBOS.shutdown();
