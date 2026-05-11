export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      advisors: {
        Row: {
          calendly_link: string | null
          created_at: string | null
          email: string | null
          fireberry_user_id: string | null
          full_name: string
          google_calendar_email: string | null
          id: string
          is_active: boolean | null
          max_daily_zooms: number | null
          notes: string | null
          phone: string | null
          updated_at: string | null
        }
        Insert: {
          calendly_link?: string | null
          created_at?: string | null
          email?: string | null
          fireberry_user_id?: string | null
          full_name: string
          google_calendar_email?: string | null
          id?: string
          is_active?: boolean | null
          max_daily_zooms?: number | null
          notes?: string | null
          phone?: string | null
          updated_at?: string | null
        }
        Update: {
          calendly_link?: string | null
          created_at?: string | null
          email?: string | null
          fireberry_user_id?: string | null
          full_name?: string
          google_calendar_email?: string | null
          id?: string
          is_active?: boolean | null
          max_daily_zooms?: number | null
          notes?: string | null
          phone?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      agent_advisors: {
        Row: {
          advisor_id: string | null
          agent_id: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          priority: number | null
        }
        Insert: {
          advisor_id?: string | null
          agent_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          priority?: number | null
        }
        Update: {
          advisor_id?: string | null
          agent_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          priority?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_advisors_advisor_id_fkey"
            columns: ["advisor_id"]
            isOneToOne: false
            referencedRelation: "advisors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_advisors_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          brand_color: string | null
          created_at: string | null
          created_by: string | null
          description: string | null
          display_name: string
          icon_url: string | null
          id: string
          name: string
          primary_goal: string | null
          product_info: Json | null
          source_funnels: string[] | null
          status: Database["public"]["Enums"]["agent_status_enum"] | null
          updated_at: string | null
          whatsapp_number: string | null
          whatsapp_provider: string | null
        }
        Insert: {
          brand_color?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          display_name: string
          icon_url?: string | null
          id?: string
          name: string
          primary_goal?: string | null
          product_info?: Json | null
          source_funnels?: string[] | null
          status?: Database["public"]["Enums"]["agent_status_enum"] | null
          updated_at?: string | null
          whatsapp_number?: string | null
          whatsapp_provider?: string | null
        }
        Update: {
          brand_color?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          display_name?: string
          icon_url?: string | null
          id?: string
          name?: string
          primary_goal?: string | null
          product_info?: Json | null
          source_funnels?: string[] | null
          status?: Database["public"]["Enums"]["agent_status_enum"] | null
          updated_at?: string | null
          whatsapp_number?: string | null
          whatsapp_provider?: string | null
        }
        Relationships: []
      }
      ai_outages: {
        Row: {
          affected_conversations: number | null
          error_message: string | null
          id: string
          provider: string | null
          resolved_at: string | null
          started_at: string | null
        }
        Insert: {
          affected_conversations?: number | null
          error_message?: string | null
          id?: string
          provider?: string | null
          resolved_at?: string | null
          started_at?: string | null
        }
        Update: {
          affected_conversations?: number | null
          error_message?: string | null
          id?: string
          provider?: string | null
          resolved_at?: string | null
          started_at?: string | null
        }
        Relationships: []
      }
      app_users: {
        Row: {
          created_at: string
          created_by: string | null
          email: string
          full_name: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          email: string
          full_name?: string | null
          id: string
          role?: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          created_at?: string
          created_by?: string | null
          email?: string
          full_name?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: []
      }
      conversations: {
        Row: {
          agent_id: string | null
          ai_provider_used:
            | Database["public"]["Enums"]["ai_provider_enum"]
            | null
          assigned_advisor_id: string | null
          consent_given_at: string | null
          consent_text_version: string | null
          created_at: string | null
          current_tag: Database["public"]["Enums"]["tag_enum"] | null
          detected_language: string | null
          estimated_age: number | null
          experiment_variant: string | null
          fireberry_lead_id: string | null
          funnel_stage: Database["public"]["Enums"]["funnel_stage_enum"] | null
          id: string
          last_interaction_at: string | null
          lead_name: string | null
          lead_phone: string
          primary_objection:
            | Database["public"]["Enums"]["objection_enum"]
            | null
          prompt_version_used: string | null
          qualifies_zoom_basic: boolean | null
          qualifies_zoom_premium: boolean | null
          quality_score: number | null
          secondary_objections: string[] | null
          source_campaign: string | null
          source_funnel: string | null
          status: Database["public"]["Enums"]["conversation_status_enum"] | null
          tag_subtype: string | null
          updated_at: string | null
          watched_series_stage: number | null
          zoom_scheduled_at: string | null
        }
        Insert: {
          agent_id?: string | null
          ai_provider_used?:
            | Database["public"]["Enums"]["ai_provider_enum"]
            | null
          assigned_advisor_id?: string | null
          consent_given_at?: string | null
          consent_text_version?: string | null
          created_at?: string | null
          current_tag?: Database["public"]["Enums"]["tag_enum"] | null
          detected_language?: string | null
          estimated_age?: number | null
          experiment_variant?: string | null
          fireberry_lead_id?: string | null
          funnel_stage?: Database["public"]["Enums"]["funnel_stage_enum"] | null
          id?: string
          last_interaction_at?: string | null
          lead_name?: string | null
          lead_phone: string
          primary_objection?:
            | Database["public"]["Enums"]["objection_enum"]
            | null
          prompt_version_used?: string | null
          qualifies_zoom_basic?: boolean | null
          qualifies_zoom_premium?: boolean | null
          quality_score?: number | null
          secondary_objections?: string[] | null
          source_campaign?: string | null
          source_funnel?: string | null
          status?:
            | Database["public"]["Enums"]["conversation_status_enum"]
            | null
          tag_subtype?: string | null
          updated_at?: string | null
          watched_series_stage?: number | null
          zoom_scheduled_at?: string | null
        }
        Update: {
          agent_id?: string | null
          ai_provider_used?:
            | Database["public"]["Enums"]["ai_provider_enum"]
            | null
          assigned_advisor_id?: string | null
          consent_given_at?: string | null
          consent_text_version?: string | null
          created_at?: string | null
          current_tag?: Database["public"]["Enums"]["tag_enum"] | null
          detected_language?: string | null
          estimated_age?: number | null
          experiment_variant?: string | null
          fireberry_lead_id?: string | null
          funnel_stage?: Database["public"]["Enums"]["funnel_stage_enum"] | null
          id?: string
          last_interaction_at?: string | null
          lead_name?: string | null
          lead_phone?: string
          primary_objection?:
            | Database["public"]["Enums"]["objection_enum"]
            | null
          prompt_version_used?: string | null
          qualifies_zoom_basic?: boolean | null
          qualifies_zoom_premium?: boolean | null
          quality_score?: number | null
          secondary_objections?: string[] | null
          source_campaign?: string | null
          source_funnel?: string | null
          status?:
            | Database["public"]["Enums"]["conversation_status_enum"]
            | null
          tag_subtype?: string | null
          updated_at?: string | null
          watched_series_stage?: number | null
          zoom_scheduled_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_assigned_advisor_id_fkey"
            columns: ["assigned_advisor_id"]
            isOneToOne: false
            referencedRelation: "advisors"
            referencedColumns: ["id"]
          },
        ]
      }
      experiments: {
        Row: {
          agent_id: string | null
          description: string | null
          ended_at: string | null
          id: string
          is_active: boolean | null
          name: string
          started_at: string | null
          variants: Json | null
        }
        Insert: {
          agent_id?: string | null
          description?: string | null
          ended_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          started_at?: string | null
          variants?: Json | null
        }
        Update: {
          agent_id?: string | null
          description?: string | null
          ended_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          started_at?: string | null
          variants?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "experiments_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_memory: {
        Row: {
          conversation_id: string
          conversation_summary: string | null
          created_at: string | null
          last_meaningful_moment: string | null
          notes_for_advisor: string | null
          promises_made: string[] | null
          q1_age: number | null
          q2_motivation: string | null
          q3_dream_change: string | null
          q4_blocker: string | null
          q5_urgency: string | null
          q6_investment: string | null
          question_version:
            | Database["public"]["Enums"]["question_version_enum"]
            | null
          red_flags: string[] | null
          updated_at: string | null
        }
        Insert: {
          conversation_id: string
          conversation_summary?: string | null
          created_at?: string | null
          last_meaningful_moment?: string | null
          notes_for_advisor?: string | null
          promises_made?: string[] | null
          q1_age?: number | null
          q2_motivation?: string | null
          q3_dream_change?: string | null
          q4_blocker?: string | null
          q5_urgency?: string | null
          q6_investment?: string | null
          question_version?:
            | Database["public"]["Enums"]["question_version_enum"]
            | null
          red_flags?: string[] | null
          updated_at?: string | null
        }
        Update: {
          conversation_id?: string
          conversation_summary?: string | null
          created_at?: string | null
          last_meaningful_moment?: string | null
          notes_for_advisor?: string | null
          promises_made?: string[] | null
          q1_age?: number | null
          q2_motivation?: string | null
          q3_dream_change?: string | null
          q4_blocker?: string | null
          q5_urgency?: string | null
          q6_investment?: string | null
          question_version?:
            | Database["public"]["Enums"]["question_version_enum"]
            | null
          red_flags?: string[] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_memory_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: true
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          ai_processing_time_ms: number | null
          content: string | null
          conversation_id: string | null
          direction: Database["public"]["Enums"]["message_direction_enum"]
          id: string
          message_type: Database["public"]["Enums"]["message_type_enum"] | null
          raw_media_url: string | null
          timestamp: string | null
          tokens_used: number | null
        }
        Insert: {
          ai_processing_time_ms?: number | null
          content?: string | null
          conversation_id?: string | null
          direction: Database["public"]["Enums"]["message_direction_enum"]
          id?: string
          message_type?: Database["public"]["Enums"]["message_type_enum"] | null
          raw_media_url?: string | null
          timestamp?: string | null
          tokens_used?: number | null
        }
        Update: {
          ai_processing_time_ms?: number | null
          content?: string | null
          conversation_id?: string | null
          direction?: Database["public"]["Enums"]["message_direction_enum"]
          id?: string
          message_type?: Database["public"]["Enums"]["message_type_enum"] | null
          raw_media_url?: string | null
          timestamp?: string | null
          tokens_used?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      opt_outs: {
        Row: {
          id: string
          lead_phone: string
          opted_out_at: string | null
          reason: string | null
        }
        Insert: {
          id?: string
          lead_phone: string
          opted_out_at?: string | null
          reason?: string | null
        }
        Update: {
          id?: string
          lead_phone?: string
          opted_out_at?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      prompts: {
        Row: {
          agent_id: string | null
          content: string
          created_at: string | null
          created_by: string | null
          id: string
          is_active: boolean | null
          notes: string | null
          prompt_type: string
          version: string
        }
        Insert: {
          agent_id?: string | null
          content: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          notes?: string | null
          prompt_type: string
          version: string
        }
        Update: {
          agent_id?: string | null
          content?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          notes?: string | null
          prompt_type?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "prompts_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_admin: { Args: never; Returns: boolean }
    }
    Enums: {
      agent_status_enum: "active" | "paused" | "archived"
      ai_provider_enum: "claude" | "gpt" | "pending" | "manual"
      app_role: "admin" | "user"
      conversation_status_enum: "active" | "paused" | "completed" | "opted_out"
      funnel_stage_enum: "cold" | "mid" | "done"
      message_direction_enum: "inbound" | "outbound"
      message_type_enum:
        | "text"
        | "audio"
        | "image"
        | "sticker"
        | "video"
        | "document"
      objection_enum:
        | "action"
        | "trust"
        | "belonging"
        | "timing"
        | "money"
        | "analytical"
        | "negative"
        | "unknown"
      question_version_enum: "A" | "B" | "C"
      tag_enum:
        | "not_hotlist"
        | "hotlist"
        | "hotlist_plus"
        | "questionnaire"
        | "zoom_scheduled"
        | "ghosted"
        | "opted_out"
        | "requires_human"
        | "underage"
        | "block_risk"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      agent_status_enum: ["active", "paused", "archived"],
      ai_provider_enum: ["claude", "gpt", "pending", "manual"],
      app_role: ["admin", "user"],
      conversation_status_enum: ["active", "paused", "completed", "opted_out"],
      funnel_stage_enum: ["cold", "mid", "done"],
      message_direction_enum: ["inbound", "outbound"],
      message_type_enum: [
        "text",
        "audio",
        "image",
        "sticker",
        "video",
        "document",
      ],
      objection_enum: [
        "action",
        "trust",
        "belonging",
        "timing",
        "money",
        "analytical",
        "negative",
        "unknown",
      ],
      question_version_enum: ["A", "B", "C"],
      tag_enum: [
        "not_hotlist",
        "hotlist",
        "hotlist_plus",
        "questionnaire",
        "zoom_scheduled",
        "ghosted",
        "opted_out",
        "requires_human",
        "underage",
        "block_risk",
      ],
    },
  },
} as const
