package poolhistory

import runsmodels "github.com/kandev/kandev/internal/runs/models"

func readStopEvidence(group receiptGroup, evidence *executionEvidence) error {
	allocation := *evidence.Allocation
	stopped, event, err := uniqueReceipt(group[runsmodels.PoolExecutionStopped], func(receipt runsmodels.PoolExecutionStopReceipt) bool {
		activity := receiptActivity(receipt.PoolExecutionIdentity, allocation.AgentType, "")
		expected, valid := activity.StoppedReceipt(allocation, receipt.Source, receipt.RuntimeInstanceID, receipt.ExecutionActivityReleased)
		return valid && expected == receipt
	})
	if err != nil {
		return err
	}
	evidence.Stop, evidence.StopEvent = stopped, event
	finished, finishedEvent, err := uniqueReceipt(group[runsmodels.PoolExecutionFinished], func(receipt runsmodels.PoolExecutionFinishReceipt) bool {
		if stopped == nil || !stopped.ExecutionActivityReleased {
			return false
		}
		expected := runsmodels.PoolExecutionFinishReceipt{PoolExecutionIdentity: allocation.PoolExecutionIdentity, StoppedSeq: event.Seq}
		return receipt == expected
	})
	if err != nil {
		return err
	}
	if finished != nil && finishedEvent.Seq <= event.Seq {
		return errReceiptUnverified
	}
	evidence.Finish, evidence.FinishEvent = finished, finishedEvent
	return nil
}
