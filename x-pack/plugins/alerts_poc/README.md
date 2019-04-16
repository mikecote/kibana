# Alerts POC

## To Do's

- Example of throttling
- ~~Default set of values per alert (subject, body, message, etc)~~
- Figure out the "Send Message" terminology
- ~~Muting functionality per scheduled alert~~
	- ~~Time based?~~

## Nice to haves

- Scenario of 100,000 different hostnames
	- Bulk get data, check function runs per host
- Add kibana task manager to POC
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
- 100,000 alerts checks on CPU usage
- 10 alerts fire an action of CPU usage > 80%

** would need to create alerts that don't interval, more tasks that are manually triggered
