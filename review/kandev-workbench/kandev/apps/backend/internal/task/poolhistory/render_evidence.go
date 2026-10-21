package poolhistory

import runsmodels "github.com/kandev/kandev/internal/runs/models"

func projectExecutionEvidence(snapshot *Snapshot, entry Entry, selection Selection, run *runsmodels.Run, item Item) Item {
	evidence, err := readExecutionEvidence(snapshot, entry, selection, run)
	if evidence != nil && evidence.Allocation != nil {
		identity := evidence.Allocation.PoolExecutionIdentity
		item.SessionID, item.ExecutionID, item.ExecutionProfileID, item.TurnID = identity.SessionID, identity.ExecutionID, identity.ExecutionProfileID, identity.TurnID
	}
	if err != nil {
		if evidence != nil {
			item = projectWorkAndTurn(evidence, item)
			if evidence.StopEvent != nil {
				item.StoppedAt = &evidence.StopEvent.CreatedAt
			}
		}
		item.State, item.Reason = stateUnknown, "receipt_unverified"
		return item
	}
	if evidence.Allocation == nil {
		if selectionIsRunCurrent(snapshot, selection, run) && run.SessionID != "" {
			item.State, item.Reason = stateUnknown, "execution_binding_missing"
		}
		return item
	}
	if selectionIsRunCurrent(snapshot, selection, run) && run.SessionID != item.SessionID {
		item.State, item.Reason = stateUnknown, "execution_binding_conflict"
		return item
	}
	item = projectWorkAndTurn(evidence, item)
	item = projectStopAndFinish(evidence, snapshot, selection, run, item)
	return item
}

func projectWorkAndTurn(evidence *executionEvidence, item Item) Item {
	if evidence.Bound != nil {
		item.OperationID, item.OperationSource = evidence.Bound.OperationID, string(evidence.Bound.OperationSource)
	}
	if evidence.Work != nil {
		item.StartedAt = &evidence.WorkEvent.CreatedAt
		if item.Current {
			item.State, item.Reason = "started", ""
		}
	}
	if evidence.Turn != nil {
		item.TurnEndedAt = &evidence.TurnEvent.CreatedAt
		item.TurnOutcome = string(evidence.Turn.Outcome)
		if item.Current {
			item.State, item.Reason = "turn_ended", ""
			if evidence.Turn.Outcome == runsmodels.PoolTurnFailed {
				item.State = "turn_failed"
			}
		}
	}
	return item
}

func projectStopAndFinish(evidence *executionEvidence, snapshot *Snapshot, selection Selection, run *runsmodels.Run, item Item) Item {
	if evidence.Stop != nil {
		item.StoppedAt = &evidence.StopEvent.CreatedAt
		item.State, item.Reason = "stopped", ""
		if !evidence.Stop.ExecutionActivityReleased {
			item.State, item.Reason = stateUnknown, "execution_release_unconfirmed"
		}
	}
	if evidence.Finish != nil {
		item.EndedAt = &evidence.FinishEvent.CreatedAt
		item.State, item.Reason = "ended", ""
		if selectionIsRunCurrent(snapshot, selection, run) && (run.Status != runsmodels.RunStatusFinished || run.FinishedAt == nil ||
			!run.FinishedAt.Equal(evidence.FinishEvent.CreatedAt) || run.Outcome == nil || *run.Outcome != runsmodels.PoolOutcomeExecutionStopped) {
			item.State, item.Reason = stateUnknown, "finish_state_conflict"
		}
	} else if selectionIsRunCurrent(snapshot, selection, run) && run.Status == runsmodels.RunStatusFinished {
		item.State, item.Reason = stateUnknown, "finish_unverified"
	}
	return item
}
