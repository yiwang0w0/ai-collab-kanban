package poolhistory

import runsmodels "github.com/kandev/kandev/internal/runs/models"

type executionEvidence struct {
	Allocation  *runsmodels.PoolExecutionAllocation
	Bound       *runsmodels.PoolExecutionIdentity
	Work        *runsmodels.PoolWorkReceipt
	WorkEvent   *runsmodels.RunEvent
	Turn        *runsmodels.PoolTurnEndReceipt
	TurnEvent   *runsmodels.RunEvent
	Stop        *runsmodels.PoolExecutionStopReceipt
	StopEvent   *runsmodels.RunEvent
	Finish      *runsmodels.PoolExecutionFinishReceipt
	FinishEvent *runsmodels.RunEvent
}

func readExecutionEvidence(snapshot *Snapshot, entry Entry, selection Selection, run *runsmodels.Run) (*executionEvidence, error) {
	group, err := claimReceipts(snapshot, selection)
	if err != nil {
		return nil, err
	}
	evidence := &executionEvidence{}
	if len(group) == 0 {
		return evidence, nil
	}
	request, intentEvent, err := uniqueReceipt(group[runsmodels.PoolLaunchAdmitted], func(request runsmodels.PoolClaimStart) bool {
		return intentMatches(request, snapshot, entry, selection, run)
	})
	if err != nil || request == nil {
		return evidence, errReceiptUnverified
	}
	allocation, allocatedEvent, err := uniqueReceipt(group[runsmodels.PoolExecutionAllocated], func(allocation runsmodels.PoolExecutionAllocation) bool {
		return allocation.ValidAllocationFor(*request) && allocation.AgentType != "" && len(allocation.AgentType) <= 256
	})
	if err != nil {
		return evidence, err
	}
	if allocation == nil {
		if len(group) != 1 {
			return evidence, errReceiptUnverified
		}
		return evidence, nil
	}
	if allocatedEvent.Seq <= intentEvent.Seq {
		return evidence, errReceiptUnverified
	}
	evidence.Allocation = allocation
	if err := readWorkEvidence(group, evidence); err != nil {
		return evidence, err
	}
	if err := readTurnEvidence(group, evidence); err != nil {
		return evidence, err
	}
	if err := readStopEvidence(group, evidence); err != nil {
		return evidence, err
	}
	if err := checkRecoveryControlEvidence(group, *request, *allocation, allocatedEvent, evidence); err != nil {
		return evidence, err
	}
	return evidence, nil
}

func intentMatches(request runsmodels.PoolClaimStart, snapshot *Snapshot, entry Entry, selection Selection, run *runsmodels.Run) bool {
	return request.Valid() && request.RunID == selection.RunID && request.ClaimID == selection.ClaimID &&
		releaseMatchesEntry(request.Release, snapshot.TaskID, entry) && request.Release.MatchesRun(run)
}

func receiptActivity(identity runsmodels.PoolExecutionIdentity, agentType string, source runsmodels.PoolStartSource) runsmodels.PoolExecutionActivity {
	activity := runsmodels.PoolExecutionActivity{TaskID: identity.TaskID, AgentProfileID: identity.AgentProfileID,
		SessionID: identity.SessionID, ExecutionID: identity.ExecutionID, TurnID: identity.TurnID,
		PromptGeneration: identity.PromptGeneration, AgentType: agentType, StartedSource: source}
	if agentType == "codex-app-server" {
		activity.OperationID = identity.OperationID
	}
	return activity
}
