package poolview

func projectEligibility(card Card, context CardContext) Eligibility {
	if card.PoolExecution != nil && card.PoolExecution.State == stateUnknown {
		return Eligibility{State: stateUnknown, Reason: card.PoolExecution.Reason}
	}
	if context.DependenciesBlocked {
		return Eligibility{State: stateBlocked, Reason: "dependencies_unresolved"}
	}
	if !context.StepExists {
		return Eligibility{State: stateUnknown, Reason: "workflow_step_unavailable"}
	}
	if context.InvalidPoolConfig {
		return Eligibility{State: stateBlocked, Reason: "pool_step_configuration_invalid"}
	}
	if card.PoolExecution != nil && card.PoolExecution.ReleasedAt != nil &&
		context.StepUpdatedAt.After(*card.PoolExecution.ReleasedAt) {
		return Eligibility{State: "requires_revalidation", Reason: "pool_stage_configuration_changed"}
	}
	if !context.PoolConfigured {
		return Eligibility{State: "not_applicable", Reason: "pool_stage_not_configured"}
	}
	if !context.WIPAdmitted || context.QueuedForStep {
		return Eligibility{State: stateBlocked, Reason: "task_not_admitted"}
	}
	if context.Profile.ValidateProfile() != nil {
		return Eligibility{State: stateBlocked, Reason: "pool_execution_capability_unavailable"}
	}
	if card.PoolExecution == nil {
		return Eligibility{State: "approval_required", Reason: "cli_quota_confirmation_required"}
	}
	switch card.PoolExecution.State {
	case "withdrawn":
		return Eligibility{State: "requires_revalidation", Reason: "pool_withdrawn"}
	case "released":
		return Eligibility{State: "dispatch_pending", Reason: "release_not_queued"}
	case "ended":
		return Eligibility{State: "requires_revalidation", Reason: "native_admission_required"}
	default:
		return Eligibility{State: "occupied", Reason: "pool_execution_pending"}
	}
}
