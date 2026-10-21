package models

import (
	"encoding/json"
	"testing"
)

type poolStepInspector interface {
	PoolExecutionProfile() (string, bool, error)
}

// @covers AC-TASKS-AGENT-POOL-001.2 AC-TASKS-AGENT-POOL-001.3
func TestPoolStepConfigurationRequiresOneFixedQueueAction(t *testing.T) {
	var step WorkflowStep
	if err := json.Unmarshal([]byte(`{"id":"implementation","workflow_id":"workflow","agent_profile_id":"fixed-profile","events":{"on_enter":[{"type":"queue_run","config":{"pool_version":1,"target":"primary","task_id":"this"}}]}}`), &step); err != nil {
		t.Fatal(err)
	}
	inspector, ok := any(&step).(poolStepInspector)
	if !ok {
		t.Fatal("缺少原生任务池阶段配置校验")
	}
	profile, pool, err := inspector.PoolExecutionProfile()
	if err != nil || !pool || profile != "fixed-profile" {
		t.Fatalf("固定池配置解析失败: %q %v %v", profile, pool, err)
	}
	tests := []struct {
		name string
		edit func(*WorkflowStep)
	}{
		{"missing_profile", func(s *WorkflowStep) { s.AgentProfileID = "" }},
		{"unknown_version", func(s *WorkflowStep) { s.Events.OnEnter[0].Config["pool_version"] = 2 }},
		{"string_version", func(s *WorkflowStep) { s.Events.OnEnter[0].Config["pool_version"] = "1" }},
		{"null_version", func(s *WorkflowStep) { s.Events.OnEnter[0].Config["pool_version"] = nil }},
		{"alternate_agent", func(s *WorkflowStep) { s.Events.OnEnter[0].Config["target"] = "agent_profile_id:other" }},
		{"other_task", func(s *WorkflowStep) { s.Events.OnEnter[0].Config["task_id"] = "other-task" }},
		{"payload_override", func(s *WorkflowStep) {
			s.Events.OnEnter[0].Config["payload"] = map[string]any{"agent_profile_id": "other"}
		}},
		{"second_queue", func(s *WorkflowStep) {
			s.Events.OnEnter = append(s.Events.OnEnter, OnEnterAction{Type: OnEnterQueueRun})
		}},
		{"auto_start", func(s *WorkflowStep) {
			s.Events.OnEnter = append(s.Events.OnEnter, OnEnterAction{Type: OnEnterAutoStartAgent})
		}},
		{"code_review", func(s *WorkflowStep) {
			s.Events.OnEnter = append(s.Events.OnEnter, OnEnterAction{Type: OnEnterRunCodeReview})
		}},
		{"fan_out", func(s *WorkflowStep) {
			s.Events.OnEnter = append(s.Events.OnEnter, OnEnterAction{Type: OnEnterQueueRunForEachParticipant})
		}},
		{"comment_queue", func(s *WorkflowStep) { s.Events.OnComment = []GenericAction{{Type: GenericActionQueueRun}} }},
		{"heartbeat_start", func(s *WorkflowStep) { s.Events.OnHeartbeat = []GenericAction{{Type: GenericActionAutoStartAgent}} }},
		{"terminal", func(s *WorkflowStep) { s.CompleteTaskOnEnter = true }},
		{"session_target", func(s *WorkflowStep) { s.SessionTarget = &WorkflowSessionTarget{} }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := json.Marshal(step)
			if err != nil {
				t.Fatal(err)
			}
			var candidate WorkflowStep
			if err := json.Unmarshal(encoded, &candidate); err != nil {
				t.Fatal(err)
			}
			tc.edit(&candidate)
			profile, pool, err := any(&candidate).(poolStepInspector).PoolExecutionProfile()
			if err == nil || !pool || profile != "" {
				t.Fatalf("歧义配置不可降级成普通任务: %q %v %v", profile, pool, err)
			}
		})
	}
	ordinary := &WorkflowStep{Events: StepEvents{OnEnter: []OnEnterAction{{Type: OnEnterAutoStartAgent}}}}
	if profile, pool, err := any(ordinary).(poolStepInspector).PoolExecutionProfile(); err != nil || pool || profile != "" {
		t.Fatalf("普通配置应保持不变: %q %v %v", profile, pool, err)
	}
}
