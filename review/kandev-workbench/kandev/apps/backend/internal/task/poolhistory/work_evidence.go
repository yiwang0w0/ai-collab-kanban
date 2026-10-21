package poolhistory

import runsmodels "github.com/kandev/kandev/internal/runs/models"

func readWorkEvidence(group receiptGroup, evidence *executionEvidence) error {
	allocation := *evidence.Allocation
	bound, _, err := uniqueReceipt(group[runsmodels.PoolExecutionBound], func(identity runsmodels.PoolExecutionIdentity) bool {
		expected, valid := receiptActivity(identity, allocation.AgentType, "").TurnEndIdentity(allocation)
		return valid && expected == identity
	})
	if err != nil {
		return err
	}
	evidence.Bound = bound
	work, event, err := uniqueReceipt(group[runsmodels.PoolWorkObserved], func(receipt runsmodels.PoolWorkReceipt) bool {
		expected, valid := receiptActivity(receipt.PoolExecutionIdentity, allocation.AgentType, receipt.StartedSource).ReceiptIdentity(allocation)
		return bound != nil && valid && expected == receipt.PoolExecutionIdentity && *bound == expected
	})
	if err != nil {
		return err
	}
	evidence.Work, evidence.WorkEvent = work, event
	return nil
}

func readTurnEvidence(group receiptGroup, evidence *executionEvidence) error {
	allocation := *evidence.Allocation
	turn, event, err := uniqueReceipt(group[runsmodels.PoolTurnEnded], func(receipt runsmodels.PoolTurnEndReceipt) bool {
		expected, valid := receiptActivity(receipt.PoolExecutionIdentity, allocation.AgentType, "").TurnEndIdentity(allocation)
		if !valid || expected != receipt.PoolExecutionIdentity ||
			(receipt.Outcome != runsmodels.PoolTurnCompleted && receipt.Outcome != runsmodels.PoolTurnFailed) {
			return false
		}
		return evidence.Bound == nil || *evidence.Bound == expected
	})
	if err != nil {
		return err
	}
	evidence.Turn, evidence.TurnEvent = turn, event
	return nil
}
