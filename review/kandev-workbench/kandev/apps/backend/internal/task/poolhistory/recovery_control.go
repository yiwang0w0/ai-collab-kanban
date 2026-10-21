package poolhistory

import runsmodels "github.com/kandev/kandev/internal/runs/models"

// 恢复控制回执必须绑定原生分配，但绝不作为物理停止或开工的证据。

func checkRecoveryControlEvidence(group receiptGroup, request runsmodels.PoolClaimStart, allocation runsmodels.PoolExecutionAllocation, allocated *runsmodels.RunEvent, evidence *executionEvidence) error {
	for _, kind := range []string{runsmodels.PoolRecoveryStopRequested, runsmodels.PoolRecoveryRequeued} {
		for _, event := range group[kind] {
			var operation runsmodels.PoolRecoveryOperation
			if !decodeReceipt(event.Payload, &operation) || !operation.ValidExecutionFor(request) ||
				operation.Execution != allocation.PoolExecutionIdentity || event.Seq <= allocated.Seq ||
				!controlKindMatches(kind, operation, event, evidence) {
				return errReceiptUnverified
			}
		}
	}
	return nil
}

func controlKindMatches(kind string, operation runsmodels.PoolRecoveryOperation, event *runsmodels.RunEvent, evidence *executionEvidence) bool {
	if kind == runsmodels.PoolRecoveryStopRequested {
		return operation.Command.Action == "stop"
	}
	return operation.Command.Action == "retry" && evidence.FinishEvent != nil &&
		operation.FinishedSeq == evidence.FinishEvent.Seq && operation.FinishedSeq < event.Seq
}
