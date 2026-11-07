// Civ13 in-game render profile. Starts the round the way an admin's "start now" does, waits for
// lighting to be created and its update queue to drain, and builds the plane masters a
// player's HUD builds (hud.dm). Webhooks and Tor checks are switched off for the run.
/datum/devtools_ingame_probe/proc/profile_name()
	return "civ13"
/datum/devtools_ingame_probe/proc/ready()
	if(config)
		config.webhook_can_fire = FALSE
		config.ToRban = FALSE
	if(ticker && ticker.current_state == GAME_STATE_PREGAME)
		ticker.admin_started = TRUE
		if(ticker.pregame_timeleft > 1)
			ticker.pregame_timeleft = 1
	return ticker && ticker.current_state == GAME_STATE_PLAYING && created_lighting_corners_and_overlays && !lighting_startup_in_progress
/datum/devtools_ingame_probe/proc/settled()
	return !lighting_update_overlays.len
/datum/devtools_ingame_probe/proc/set_time_of_day(tod)
	if(!(tod in time_of_day2luminosity))
		throw EXCEPTION("unknown time_of_day [tod]")
	update_lighting(tod, null, FALSE)
/datum/devtools_ingame_probe/proc/see_invisible()
	return SEE_INVISIBLE_LIVING
/datum/devtools_ingame_probe/proc/time_of_day()
	return time_of_day
/datum/devtools_ingame_probe/proc/plane_masters(list/out)
	for(var/t in subtypesof(/obj/screen/plane_master))
		if(t == /obj/screen/plane_master/light_mask && !LIGHTING_COMPOSITION_V2)
			continue
		var/obj/screen/plane_master/P = new t()
		P.backdrop(null)
		out += list(list("type" = "[t]", "appearance" = app_index(P, ref(P.appearance))))
