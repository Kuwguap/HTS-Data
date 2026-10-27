/**
 * Database contract for the Kharis Shuttle Supabase project.
 *
 * This file is the source of truth that the SQL migrations in supabase/migrations
 * must match. After the migrations are applied it is regenerated with
 * `supabase gen types typescript` and diffed against this hand-written version;
 * any difference is a bug in one or the other.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "student" | "driver" | "admin";
export type TripDirection = "to_campus" | "to_hostel";
export type TripStatus = "scheduled" | "boarding" | "departed" | "arrived" | "cancelled" | "expired";
export type BookingStatus = "confirmed" | "waitlisted" | "cancelled" | "boarded" | "no_show";
export type PickupRequestStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired" | "completed";
export type PushStatus = "pending" | "sending" | "sent" | "failed" | "skipped";
export type NotificationKind =
  | "daily_announcement"
  | "trip_reminder"
  | "trip_nudge"
  | "trip_departed"
  | "booking_confirmed"
  | "booking_waitlisted"
  | "booking_promoted"
  | "booking_cancelled"
  | "trip_cancelled"
  | "trip_updated"
  | "driver_manifest"
  | "driver_booking_update"
  | "pickup_request_new"
  | "pickup_request_accepted"
  | "pickup_request_declined"
  | "pickup_request_expired"
  | "return_announcement"
  | "broadcast"
  | "test";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          username: string;
          full_name: string;
          phone: string | null;
          room: string | null;
          role: UserRole;
          is_active: boolean;
          reminders_enabled: boolean;
          onboarded_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          username: string;
          full_name: string;
          phone?: string | null;
          room?: string | null;
          role?: UserRole;
          is_active?: boolean;
          reminders_enabled?: boolean;
          onboarded_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          username?: string;
          full_name?: string;
          phone?: string | null;
          room?: string | null;
          role?: UserRole;
          is_active?: boolean;
          reminders_enabled?: boolean;
          onboarded_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      settings: {
        Row: {
          id: number;
          hostel_name: string;
          campus_name: string;
          timezone: string;
          fare_pesewas: number;
          currency: string;
          payment_note: string;
          enquiry_phone: string | null;
          default_seat_capacity: number;
          reminder_lead_minutes: number;
          nudge_minutes: number;
          manifest_lead_minutes: number;
          booking_cutoff_minutes: number;
          booking_open_days_ahead: number;
          daily_announcement_enabled: boolean;
          daily_announcement_time: string;
          location_stale_seconds: number;
          signup_code: string | null;
          default_driver_id: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: number;
          hostel_name?: string;
          campus_name?: string;
          timezone?: string;
          fare_pesewas?: number;
          currency?: string;
          payment_note?: string;
          enquiry_phone?: string | null;
          default_seat_capacity?: number;
          reminder_lead_minutes?: number;
          nudge_minutes?: number;
          manifest_lead_minutes?: number;
          booking_cutoff_minutes?: number;
          booking_open_days_ahead?: number;
          daily_announcement_enabled?: boolean;
          daily_announcement_time?: string;
          location_stale_seconds?: number;
          signup_code?: string | null;
          default_driver_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          id?: number;
          hostel_name?: string;
          campus_name?: string;
          timezone?: string;
          fare_pesewas?: number;
          currency?: string;
          payment_note?: string;
          enquiry_phone?: string | null;
          default_seat_capacity?: number;
          reminder_lead_minutes?: number;
          nudge_minutes?: number;
          manifest_lead_minutes?: number;
          booking_cutoff_minutes?: number;
          booking_open_days_ahead?: number;
          daily_announcement_enabled?: boolean;
          daily_announcement_time?: string;
          location_stale_seconds?: number;
          signup_code?: string | null;
          default_driver_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      message_templates: {
        Row: {
          key: NotificationKind;
          title: string;
          body: string;
          updated_at: string;
        };
        Insert: {
          key: NotificationKind;
          title: string;
          body: string;
          updated_at?: string;
        };
        Update: {
          key?: NotificationKind;
          title?: string;
          body?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      pickup_locations: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          direction: TripDirection | null;
          lat: number;
          lng: number;
          sort_order: number;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string | null;
          direction?: TripDirection | null;
          lat: number;
          lng: number;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string | null;
          direction?: TripDirection | null;
          lat?: number;
          lng?: number;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      schedule_times: {
        Row: {
          id: string;
          direction: TripDirection;
          depart_time: string;
          days_of_week: number[];
          label: string | null;
          seat_capacity: number | null;
          bookings_enabled: boolean;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          direction: TripDirection;
          depart_time: string;
          days_of_week?: number[];
          label?: string | null;
          seat_capacity?: number | null;
          bookings_enabled?: boolean;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          direction?: TripDirection;
          depart_time?: string;
          days_of_week?: number[];
          label?: string | null;
          seat_capacity?: number | null;
          bookings_enabled?: boolean;
          is_active?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      service_days_off: {
        Row: {
          service_date: string;
          reason: string | null;
        };
        Insert: {
          service_date: string;
          reason?: string | null;
        };
        Update: {
          service_date?: string;
          reason?: string | null;
        };
        Relationships: [];
      };
      trips: {
        Row: {
          id: string;
          service_date: string;
          direction: TripDirection;
          departure_at: string;
          schedule_time_id: string | null;
          status: TripStatus;
          seat_capacity: number;
          confirmed_count: number;
          waitlist_count: number;
          bookings_enabled: boolean;
          driver_id: string | null;
          origin_label: string;
          destination_label: string;
          reminder_at: string | null;
          reminder_sent_at: string | null;
          nudge_sent_at: string | null;
          manifest_sent_at: string | null;
          boarding_at: string | null;
          departed_at: string | null;
          arrived_at: string | null;
          cancelled_at: string | null;
          cancel_reason: string | null;
          last_lat: number | null;
          last_lng: number | null;
          last_heading: number | null;
          last_speed_mps: number | null;
          last_location_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          service_date: string;
          direction: TripDirection;
          departure_at: string;
          schedule_time_id?: string | null;
          status?: TripStatus;
          seat_capacity: number;
          confirmed_count?: number;
          waitlist_count?: number;
          bookings_enabled?: boolean;
          driver_id?: string | null;
          origin_label: string;
          destination_label: string;
          reminder_at?: string | null;
          reminder_sent_at?: string | null;
          nudge_sent_at?: string | null;
          manifest_sent_at?: string | null;
          boarding_at?: string | null;
          departed_at?: string | null;
          arrived_at?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          last_lat?: number | null;
          last_lng?: number | null;
          last_heading?: number | null;
          last_speed_mps?: number | null;
          last_location_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          service_date?: string;
          direction?: TripDirection;
          departure_at?: string;
          schedule_time_id?: string | null;
          status?: TripStatus;
          seat_capacity?: number;
          confirmed_count?: number;
          waitlist_count?: number;
          bookings_enabled?: boolean;
          driver_id?: string | null;
          origin_label?: string;
          destination_label?: string;
          reminder_at?: string | null;
          reminder_sent_at?: string | null;
          nudge_sent_at?: string | null;
          manifest_sent_at?: string | null;
          boarding_at?: string | null;
          departed_at?: string | null;
          arrived_at?: string | null;
          cancelled_at?: string | null;
          cancel_reason?: string | null;
          last_lat?: number | null;
          last_lng?: number | null;
          last_heading?: number | null;
          last_speed_mps?: number | null;
          last_location_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      bookings: {
        Row: {
          id: string;
          trip_id: string;
          user_id: string;
          pickup_location_id: string | null;
          pickup_note: string | null;
          status: BookingStatus;
          waitlist_position: number | null;
          agreed_cash_at: string;
          source: string;
          created_at: string;
          updated_at: string;
          cancelled_at: string | null;
          promoted_at: string | null;
          boarded_at: string | null;
        };
        Insert: {
          id?: string;
          trip_id: string;
          user_id: string;
          pickup_location_id?: string | null;
          pickup_note?: string | null;
          status: BookingStatus;
          waitlist_position?: number | null;
          agreed_cash_at?: string;
          source?: string;
          created_at?: string;
          updated_at?: string;
          cancelled_at?: string | null;
          promoted_at?: string | null;
          boarded_at?: string | null;
        };
        Update: {
          id?: string;
          trip_id?: string;
          user_id?: string;
          pickup_location_id?: string | null;
          pickup_note?: string | null;
          status?: BookingStatus;
          waitlist_position?: number | null;
          agreed_cash_at?: string;
          source?: string;
          created_at?: string;
          updated_at?: string;
          cancelled_at?: string | null;
          promoted_at?: string | null;
          boarded_at?: string | null;
        };
        Relationships: [];
      };
      pickup_requests: {
        Row: {
          id: string;
          rider_id: string;
          trip_id: string | null;
          direction: TripDirection;
          pickup_location_id: string | null;
          custom_place: string | null;
          lat: number | null;
          lng: number | null;
          note: string | null;
          status: PickupRequestStatus;
          driver_id: string | null;
          responded_at: string | null;
          response_note: string | null;
          expires_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          rider_id: string;
          trip_id?: string | null;
          direction: TripDirection;
          pickup_location_id?: string | null;
          custom_place?: string | null;
          lat?: number | null;
          lng?: number | null;
          note?: string | null;
          status?: PickupRequestStatus;
          driver_id?: string | null;
          responded_at?: string | null;
          response_note?: string | null;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          rider_id?: string;
          trip_id?: string | null;
          direction?: TripDirection;
          pickup_location_id?: string | null;
          custom_place?: string | null;
          lat?: number | null;
          lng?: number | null;
          note?: string | null;
          status?: PickupRequestStatus;
          driver_id?: string | null;
          responded_at?: string | null;
          response_note?: string | null;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      trip_locations: {
        Row: {
          id: number;
          trip_id: string;
          driver_id: string | null;
          lat: number;
          lng: number;
          accuracy_m: number | null;
          heading: number | null;
          speed_mps: number | null;
          recorded_at: string;
          inserted_at: string;
        };
        Insert: {
          id?: number;
          trip_id: string;
          driver_id?: string | null;
          lat: number;
          lng: number;
          accuracy_m?: number | null;
          heading?: number | null;
          speed_mps?: number | null;
          recorded_at: string;
          inserted_at?: string;
        };
        Update: {
          id?: number;
          trip_id?: string;
          driver_id?: string | null;
          lat?: number;
          lng?: number;
          accuracy_m?: number | null;
          heading?: number | null;
          speed_mps?: number | null;
          recorded_at?: string;
          inserted_at?: string;
        };
        Relationships: [];
      };
      push_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent: string | null;
          platform: string | null;
          created_at: string;
          last_seen_at: string;
          last_success_at: string | null;
          fail_count: number;
          disabled_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent?: string | null;
          platform?: string | null;
          created_at?: string;
          last_seen_at?: string;
          last_success_at?: string | null;
          fail_count?: number;
          disabled_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          endpoint?: string;
          p256dh?: string;
          auth?: string;
          user_agent?: string | null;
          platform?: string | null;
          created_at?: string;
          last_seen_at?: string;
          last_success_at?: string | null;
          fail_count?: number;
          disabled_at?: string | null;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          kind: NotificationKind;
          title: string;
          body: string;
          url: string | null;
          data: Json;
          dedupe_key: string;
          ttl_seconds: number;
          urgency: string;
          collapse_tag: string | null;
          created_at: string;
          read_at: string | null;
          push_status: PushStatus;
          push_attempts: number;
          push_claimed_at: string | null;
          push_sent_at: string | null;
          push_error: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: NotificationKind;
          title: string;
          body: string;
          url?: string | null;
          data?: Json;
          dedupe_key: string;
          ttl_seconds?: number;
          urgency?: string;
          collapse_tag?: string | null;
          created_at?: string;
          read_at?: string | null;
          push_status?: PushStatus;
          push_attempts?: number;
          push_claimed_at?: string | null;
          push_sent_at?: string | null;
          push_error?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          kind?: NotificationKind;
          title?: string;
          body?: string;
          url?: string | null;
          data?: Json;
          dedupe_key?: string;
          ttl_seconds?: number;
          urgency?: string;
          collapse_tag?: string | null;
          created_at?: string;
          read_at?: string | null;
          push_status?: PushStatus;
          push_attempts?: number;
          push_claimed_at?: string | null;
          push_sent_at?: string | null;
          push_error?: string | null;
        };
        Relationships: [];
      };
      login_attempts: {
        Row: {
          username: string;
          failed_count: number;
          locked_until: string | null;
          updated_at: string;
        };
        Insert: {
          username: string;
          failed_count?: number;
          locked_until?: string | null;
          updated_at?: string;
        };
        Update: {
          username?: string;
          failed_count?: number;
          locked_until?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      tick_runs: {
        Row: {
          id: number;
          ran_at: string;
          now_ts: string;
          trips_created: number;
          daily_enqueued: number;
          reminders_enqueued: number;
          nudges_enqueued: number;
          manifests_enqueued: number;
          expired_trips: number;
          expired_requests: number;
          pushes_sent: number;
          pushes_failed: number;
          duration_ms: number | null;
          note: string | null;
        };
        Insert: {
          id?: number;
          ran_at?: string;
          now_ts: string;
          trips_created?: number;
          daily_enqueued?: number;
          reminders_enqueued?: number;
          nudges_enqueued?: number;
          manifests_enqueued?: number;
          expired_trips?: number;
          expired_requests?: number;
          pushes_sent?: number;
          pushes_failed?: number;
          duration_ms?: number | null;
          note?: string | null;
        };
        Update: {
          id?: number;
          ran_at?: string;
          now_ts?: string;
          trips_created?: number;
          daily_enqueued?: number;
          reminders_enqueued?: number;
          nudges_enqueued?: number;
          manifests_enqueued?: number;
          expired_trips?: number;
          expired_requests?: number;
          pushes_sent?: number;
          pushes_failed?: number;
          duration_ms?: number | null;
          note?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      record_login_failure: {
        Args: { p_username: string; p_max_failures?: number; p_lockout_minutes?: number };
        Returns: Database["public"]["Tables"]["login_attempts"]["Row"];
      };
      my_role: {
        Args: Record<PropertyKey, never>;
        Returns: UserRole;
      };
      local_now: {
        Args: { p_now?: string | null };
        Returns: string;
      };
      render_template: {
        Args: { p_kind: NotificationKind; p_vars: Json };
        Returns: { title: string; body: string }[];
      };
      enqueue_notification: {
        Args: {
          p_user_ids: string[];
          p_kind: NotificationKind;
          p_vars: Json;
          p_url?: string | null;
          p_dedupe_prefix: string;
          p_ttl_seconds?: number;
          p_urgency?: string;
          p_collapse_tag?: string | null;
        };
        Returns: number;
      };
      book_seat: {
        Args: {
          p_user_id: string;
          p_trip_id: string;
          p_pickup_location_id?: string | null;
          p_pickup_note?: string | null;
          p_source?: string;
        };
        Returns: Database["public"]["Tables"]["bookings"]["Row"];
      };
      cancel_booking: {
        Args: { p_user_id: string; p_booking_id: string; p_by?: string };
        Returns: Json;
      };
      promote_waitlist: {
        Args: { p_trip_id: string };
        Returns: Database["public"]["Tables"]["bookings"]["Row"][];
      };
      set_booking_status: {
        Args: { p_booking_id: string; p_status: BookingStatus; p_actor?: string | null };
        Returns: Database["public"]["Tables"]["bookings"]["Row"];
      };
      materialize_trips: {
        Args: { p_from: string; p_to: string };
        Returns: number;
      };
      create_adhoc_trip: {
        Args: {
          p_direction: TripDirection;
          p_origin: string;
          p_destination: string;
          p_departure_at: string;
          p_seat_capacity?: number | null;
          p_driver_id?: string | null;
          p_created_by?: string | null;
        };
        Returns: Database["public"]["Tables"]["trips"]["Row"];
      };
      set_trip_status: {
        Args: { p_trip_id: string; p_status: TripStatus; p_actor?: string | null; p_reason?: string | null };
        Returns: Database["public"]["Tables"]["trips"]["Row"];
      };
      run_tick: {
        Args: { p_now?: string | null };
        Returns: Database["public"]["Tables"]["tick_runs"]["Row"];
      };
      claim_pending_notifications: {
        Args: { p_limit?: number };
        Returns: {
          id: string;
          user_id: string;
          kind: NotificationKind;
          title: string;
          body: string;
          url: string | null;
          data: Json;
          ttl_seconds: number;
          urgency: string;
          collapse_tag: string | null;
          /** Attempts so far INCLUDING this claim (1 on the first delivery attempt). */
          push_attempts: number;
          subscriptions: Json;
        }[];
      };
      finish_notification: {
        Args: { p_id: string; p_status: PushStatus; p_error?: string | null };
        Returns: undefined;
      };
      mark_notifications_read: {
        Args: { p_ids: string[] };
        Returns: undefined;
      };
      cron_tick: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      // Internal helpers (service role only); exposed here because they exist in `public`.
      booking_promote_next: {
        Args: { p_trip_id: string };
        Returns: Database["public"]["Tables"]["bookings"]["Row"] | null;
      };
      booking_renumber_waitlist: {
        Args: { p_trip_id: string };
        Returns: undefined;
      };
      /** 1000 → "GH₵10", 1250 → "GH₵12.50" (same output as formatFare in lib/time.ts). */
      format_fare: {
        Args: { p_pesewas: number; p_currency?: string };
        Returns: string;
      };
      /** "7:30 AM" in settings.timezone. */
      format_local_time: {
        Args: { p_at: string };
        Returns: string;
      };
      /** Single-pass {placeholder} substitution of an arbitrary template string (service role). */
      render_text: {
        Args: { p_template: string; p_vars: Json };
        Returns: string;
      };
    };
    Enums: {
      user_role: UserRole;
      trip_direction: TripDirection;
      trip_status: TripStatus;
      booking_status: BookingStatus;
      pickup_request_status: PickupRequestStatus;
      push_status: PushStatus;
      notification_kind: NotificationKind;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database["public"];

export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"];
export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T];
export type FunctionArgs<T extends keyof PublicSchema["Functions"]> = PublicSchema["Functions"][T]["Args"];
export type FunctionReturns<T extends keyof PublicSchema["Functions"]> = PublicSchema["Functions"][T]["Returns"];

// Convenient aliases used across the app.
export type Profile = Tables<"profiles">;
export type Settings = Tables<"settings">;
export type MessageTemplate = Tables<"message_templates">;
export type PickupLocation = Tables<"pickup_locations">;
export type ScheduleTime = Tables<"schedule_times">;
export type Trip = Tables<"trips">;
export type Booking = Tables<"bookings">;
export type PickupRequest = Tables<"pickup_requests">;
export type TripLocation = Tables<"trip_locations">;
export type PushSubscriptionRow = Tables<"push_subscriptions">;
export type Notification = Tables<"notifications">;
export type TickRun = Tables<"tick_runs">;

/** Shape of each entry in claim_pending_notifications().subscriptions */
export type ClaimedSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** Shape returned by cancel_booking() (jsonb). */
export type CancelBookingResult = {
  cancelled: Booking;
  promoted: Booking | null;
};

/** Payload broadcast on the private realtime topic `trip:<trip_id>` for every GPS fix. */
export type TripLocationBroadcast = {
  trip_id: string;
  lat: number;
  lng: number;
  heading: number | null;
  speed_mps: number | null;
  accuracy_m: number | null;
  recorded_at: string;
};
