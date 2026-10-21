package service

import (
	"context"

	settingsmodels "github.com/kandev/kandev/internal/agent/settings/models"
	"github.com/kandev/kandev/internal/task/models"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
)

// PoolReleaseConfirmation 只接受确认和版本前提，不接受执行者、批准者或派发时间。
type PoolReleaseConfirmation struct {
	ConfirmCLIQuota         bool   `json:"confirm_cli_quota"`
	ExpectedResourceVersion string `json:"expected_resource_version"`
	ExpectedStepVersion     string `json:"expected_step_version"`
}

func (s *Service) poolMoveContext(ctx context.Context, task *models.Task, step *wfmodels.WorkflowStep, fromStepID string, opts MoveTaskOptions) (context.Context, error) {
	if opts.PoolRelease == nil {
		return ctx, nil
	}
	profileID, pool, err := step.PoolExecutionProfile()
	if err != nil {
		return nil, err
	}
	if !pool || fromStepID == step.ID {
		return nil, wfmodels.ErrInvalidPoolStep
	}
	if s.poolRunQueue == nil {
		return nil, models.ErrPoolExecutionUnavailable
	}
	if err := s.validatePoolExecution(ctx, task, step, profileID); err != nil {
		return nil, err
	}
	confirmation := opts.PoolRelease
	return models.WithPoolReleaseIntent(ctx, models.PoolReleaseIntent{TaskID: task.ID, WorkspaceID: task.WorkspaceID,
		WorkflowID: task.WorkflowID, StepID: step.ID, ExpectedAgentProfileID: profileID,
		ExpectedResourceVersion: confirmation.ExpectedResourceVersion, ExpectedStepVersion: confirmation.ExpectedStepVersion,
		ConfirmCLIQuota: confirmation.ConfirmCLIQuota}), nil
}

type poolAgentReader interface {
	GetAgent(context.Context, string) (*settingsmodels.Agent, error)
}

func (s *Service) validatePoolExecution(ctx context.Context, task *models.Task, step *wfmodels.WorkflowStep, profileID string) error {
	agents, ok := s.agentProfiles.(poolAgentReader)
	if !ok || s.agentProfileExecutorValidator == nil {
		return models.ErrPoolExecutionUnavailable
	}
	profile, err := s.agentProfiles.GetAgentProfile(ctx, profileID)
	if err != nil || profile == nil {
		return models.ErrPoolExecutionUnavailable
	}
	agent, err := agents.GetAgent(ctx, profile.AgentID)
	if err != nil || agent == nil {
		return models.ErrPoolExecutionUnavailable
	}
	if replacement, bound := task.WorkflowAgentOverrides.ReplacementFor(task.WorkflowID, step.ID); bound && replacement != profileID {
		return models.ErrPoolExecutionUnavailable
	}
	executor, executorProfile, err := s.resolveWorkflowAgentOverrideExecutor(ctx, &CreateTaskRequest{WorkspaceID: task.WorkspaceID, Metadata: task.Metadata})
	if err != nil {
		return models.ErrPoolExecutionUnavailable
	}
	choice := poolExecutionCandidate(task.WorkspaceID, profile, agent, executor)
	if err := choice.Validate(); err != nil {
		return err
	}
	if err := s.agentProfileExecutorValidator.ValidateAgentProfileForExecutor(ctx, profile, executor, executorProfile); err != nil {
		return models.ErrPoolExecutionUnavailable
	}
	return nil
}

func poolExecutionCandidate(workspaceID string, profile *settingsmodels.AgentProfile, agent *settingsmodels.Agent, executor *models.Executor) models.PoolExecutionCandidate {
	choice := models.PoolExecutionCandidate{WorkspaceID: workspaceID, AgentProfileID: profile.ID,
		ProfileAgentRecordID: profile.AgentID, AgentRecordID: agent.ID, AgentFamily: agent.Name,
		ProfileWorkspaceID: profile.WorkspaceID, Enabled: profile.Enabled, Deleted: profile.DeletedAt != nil,
		ProviderKind: profile.ProviderKind, AutoFallback: profile.AutoFallback, FallbackModel: profile.FallbackModel,
		CLIPassthrough: profile.CLIPassthrough, ExecutionAgentProfileID: profile.ExecutionAgentProfileID,
		CustomTUI: agent.TUIConfig != nil, ExecutorType: executor.Type, ExecutorStatus: executor.Status}
	if agent.WorkspaceID != nil {
		choice.AgentWorkspaceID = *agent.WorkspaceID
	}
	return choice
}
