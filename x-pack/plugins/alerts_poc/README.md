# Alerts POC

## To Do's

- ~~Example of throttling~~
- ~~Default set of values per alert (subject, body, message, etc)~~
- Figure out the "Send Message" terminology
- ~~Muting functionality per scheduled alert~~
	- ~~Time based?~~
- UI

## Nice to haves

- ~~Scenario of 100,000 different hostnames~~
- ~~Add kibana task manager to POC~~
- Resiliency
- Audit log
- Queues?
	- Sending emails goes into a queue
	- Leverage task manager?

## Handling 100,000 server CPU checks every 1m

#### Option 1

- 100,000 alerts are scheduled, each do their own query and fires

#### Option 2

- 1 alert is scheduled to gather stats on the whole fleet
- fires action for each server
- action is to make task scheduler manually execute the alert with parameters
	- This would have to provide actions in the manual call
- 100,000 alerts checks on CPU usage
- 10 alerts fire an action of CPU usage > 80%

#### Option 3

- Make `execute` of alert service handle bulk requests

** would need to create alerts that don't interval, more tasks that are manually triggered

Options 2 implementation:

```
// Alerts
alertService.register({
	id: 'fleet-get-stats',
	description: 'Check CPU usage for the fleet',
	async({ fire }, {}, state) {
		const serverStats = [
			{
				id: 1,
				cpuUsage: 60,
				ramUsage: 50,
			},
			{
				id: 2,
				cpuUsage: 80,
				ramUsage: 50,
			},
			{
				id: 3,
				cpuUsage: 96,
				ramUsage: 80,
			},
		];
		serverStats.forEach(stats => fire('default', stats));
		return state;
	},
});
alertService.register({
	id: 'fleet-cpu-check',
	description: 'Check CPU usage based on given stats',
	async({ fire }, { warningThreshold, severeThreshold, serverInfo }, state) {
		const cpuUsage = serverInfo.cpuUsage;
		if (cpuUsage > severeThreshold) {
			fire('severe', { cpuUsage });
		} else if (cpuUsage > warningThreshold) {
			fire('warning', { cpuUsage });
		}
		return { cpuUsage };
	},
});

// Scheduled Alerts
alertService.schedule({
	id: 'fleet-get-stats',
	interval: 10 * 1000, // 10s
	actionGroups: {
		default: [
			{
				id: 'exec-task',
				params: {
					task: 'fleet-cpu-check',
				},
			},
		],
	},
});

// Connector
actionService.registerConnector('exec-task', async (connectorOptions, params) => {
	await taskManager.runTask(params.task, params); // ???
});

// Action
actionService.createAction({
	id: 'exec-task',
	description: 'Execute task in task manager',
	connector: 'exec-task',
	attributes: {},
});
```

Option 3 implementation

```
alertService.register({
	id: 'fleet-cpu-check',
	desc: 'Check CPU usage above threshold',
	async execute(alerts) {
		const servers = [
			{
				id: 1,
				cpuUsage: 60,
				ramUsage: 50,
			},
			{
				id: 2,
				cpuUsage: 80,
				ramUsage: 50,
			},
			{
				id: 3,
				cpuUsage: 96,
				ramUsage: 80,
			},
		];
		alerts.forEach(({ fire, warningThreshold, severeThreshold, state }) => {
			const { cpuUsage } = servers.find(server => server.id === state.serverId);
			if (cpuUsage > severeThreshold) {
				fire('severe', { cpuUsage });
			} else if (cpuUsage > warningThreshold) {
				fire('warning', { cpuUsage });
			}
		});
	},
});
```

## Task Manager Changes

- Add `createTask` function
- Change `scheduleTask` to create the task then schedule with parameters
- Change `runTask` which will accept parameters on every call instead of using cache
- Change alerting service `schedule` to not provide a callback when scheduling a task
