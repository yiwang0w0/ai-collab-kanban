package models

import (
	"errors"
	"strings"
)

const PoolVersionConfigKey = "pool_version"

var ErrInvalidPoolStep = errors.New("pool_step_configuration_invalid")

// PoolExecutionProfile 只识别显式池标记，不因分配负责人或普通 queue_run 自动入池。
func (s *WorkflowStep) PoolExecutionProfile() (string, bool, error) {
	if s == nil || !s.hasPoolMarker() {
		return "", false, nil
	}
	if strings.TrimSpace(s.AgentProfileID) == "" || s.SessionTarget != nil || s.CompleteTaskOnEnter {
		return "", true, ErrInvalidPoolStep
	}
	queues := 0
	for _, action := range s.Events.OnEnter {
		if action.Type == OnEnterQueueRun {
			queues++
			if !validPoolQueueConfig(action.Config) {
				return "", true, ErrInvalidPoolStep
			}
		} else if poolLaunchAction(string(action.Type)) || hasPoolMarker(action.Config) {
			return "", true, ErrInvalidPoolStep
		}
	}
	if queues != 1 || s.hasOtherPoolLauncher() {
		return "", true, ErrInvalidPoolStep
	}
	return s.AgentProfileID, true, nil
}

func hasPoolMarker(config map[string]any) bool {
	_, present := config[PoolVersionConfigKey]
	return present
}

func (s *WorkflowStep) hasPoolMarker() bool {
	for _, action := range s.Events.OnEnter {
		if hasPoolMarker(action.Config) {
			return true
		}
	}
	for _, group := range s.poolGenericGroups() {
		for _, action := range group {
			if hasPoolMarker(action.Config) {
				return true
			}
		}
	}
	return false
}

func (s *WorkflowStep) poolGenericGroups() [][]GenericAction {
	return [][]GenericAction{s.Events.OnComment, s.Events.OnBlockerResolved, s.Events.OnChildrenCompleted,
		s.Events.OnApprovalResolved, s.Events.OnHeartbeat, s.Events.OnBudgetAlert, s.Events.OnAgentError}
}

func (s *WorkflowStep) hasOtherPoolLauncher() bool {
	for _, group := range s.poolGenericGroups() {
		for _, action := range group {
			if poolLaunchAction(string(action.Type)) || hasPoolMarker(action.Config) {
				return true
			}
		}
	}
	return false
}

func poolLaunchAction(kind string) bool {
	switch kind {
	case "queue_run", "auto_start_agent", "queue_run_for_each_participant", "run_code_review":
		return true
	default:
		return false
	}
}

func validPoolQueueConfig(config map[string]any) bool {
	if !poolVersionOne(config[PoolVersionConfigKey]) {
		return false
	}
	for key, allowed := range map[string]string{"target": "primary", "task_id": "this", "reason": "pool_dispatch"} {
		if value, present := config[key]; present && value != "" && value != allowed {
			return false
		}
	}
	_, payloadOverride := config["payload"]
	return !payloadOverride
}

func poolVersionOne(value any) bool {
	switch version := value.(type) {
	case int:
		return version == 1
	case int64:
		return version == 1
	case float64:
		return version == 1
	default:
		return false
	}
}
