import { createReadCounterData } from "../../../entities/monitor/TypeRefs.js"
import { assertWorkerOrNode } from "../../../common/Env.js"
import { IServiceExecutor } from "../../../common/ServiceRequest.js"
import { CounterService } from "../../../entities/monitor/Services.js"

assertWorkerOrNode()

export class CounterFacade {
	constructor(private readonly serviceExecutor: IServiceExecutor) {}

	async readCounterValue(monitorValue: string, ownerId: Id): Promise<NumberString | null> {
		const counterData = createReadCounterData({
			monitor: monitorValue,
			owner: ownerId,
		})
		const counterReturn = await this.serviceExecutor.get(CounterService, counterData)
		return counterReturn.value
	}
}
