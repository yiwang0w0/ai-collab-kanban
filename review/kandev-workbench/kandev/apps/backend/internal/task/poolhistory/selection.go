package poolhistory

import runsmodels "github.com/kandev/kandev/internal/runs/models"

// SelectionSeeds 仅让已核对的唯一运行进入领取查询，不透传冲突行的标识。
func SelectionSeeds(snapshot *Snapshot) []Seed {
	seeds := make([]Seed, 0, len(snapshot.Entries))
	for _, entry := range snapshot.Entries {
		seed := Seed{EntryID: entry.ID}
		if validEntry(entry) && !snapshot.Incomplete {
			valid, _ := runsForEntry(snapshot, entry)
			if len(valid) == 1 {
				seed.RunID = valid[0].ID
			}
			if clearance, present := clearanceForEntry(snapshot, entry); present {
				seed.RunID = ""
				if clearance != nil && len(valid) == 0 {
					seed.RunID = clearance.RunID
				}
			}
		}
		seeds = append(seeds, seed)
	}
	return seeds
}

func projectSelection(snapshot *Snapshot, selection Selection) Item {
	var entry Entry
	for _, candidate := range snapshot.Entries {
		if candidate.ID == selection.EntryID {
			entry = candidate
			break
		}
	}
	item := projectEntry(snapshot, entry)
	if item.RunID == "" || item.RunID != selection.RunID || selection.ClaimID == "" ||
		selection.ClaimedAt == nil || selection.ClaimedAt.IsZero() || len(selection.ClaimID) > 256 {
		return item
	}
	if clearance, present := clearanceForEntry(snapshot, entry); present {
		if clearance != nil && item.Reason == "history_cleaned" && selection.WorkspaceID == clearance.WorkspaceID {
			release, _ := clearance.Release()
			item.ClaimID, item.ClaimedAt = selection.ClaimID, selection.ClaimedAt
			item.ClaimedAgentProfileID = release.AgentProfileID
		}
		return item
	}
	valid, _ := runsForEntry(snapshot, entry)
	if len(valid) != 1 || selection.WorkspaceID != valid[0].WorkspaceID {
		item.State, item.Reason = stateUnknown, "claim_unverified"
		return item
	}
	run := valid[0]
	item.ClaimID, item.ClaimedAt = selection.ClaimID, selection.ClaimedAt
	item.ClaimedAgentProfileID = run.AgentProfileID
	item.State, item.Reason = stateUnknown, "historical_outcome_unverified"
	item.Current = selectionIsCurrent(snapshot, entry, selection, run)
	if item.Current && run.Status == runsmodels.RunStatusClaimed {
		item.State, item.Reason = "claimed", ""
	}
	item = projectExecutionEvidence(snapshot, entry, selection, run, item)
	return queueCauseForClaim(snapshot, entry, run, selection, item)
}

func selectionIsCurrent(snapshot *Snapshot, entry Entry, selection Selection, run *runsmodels.Run) bool {
	if entry.ID != snapshot.LatestEntryID || entry.WorkflowID != snapshot.CurrentWorkflowID ||
		entry.StepID != snapshot.CurrentStepID {
		return false
	}
	return selectionIsRunCurrent(snapshot, selection, run)
}

func selectionIsRunCurrent(snapshot *Snapshot, selection Selection, run *runsmodels.Run) bool {
	if run.ClaimedAt == nil || selection.ClaimedAt == nil || !run.ClaimedAt.Equal(*selection.ClaimedAt) {
		return false
	}
	for _, count := range snapshot.ClaimCounts {
		if count.RunID == run.ID {
			return count.CurrentMatches == 1
		}
	}
	return false
}
