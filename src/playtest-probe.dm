// byond-devtools playtest probe. Appended to a temporary copy of a game's .dme by `playtest`.
// It turns on line numbers in runtime errors (DEBUG), optionally profiles procs, writes a
// heartbeat and profile snapshot every 30 s, and shuts the world down when the time limit set
// by the devtools_minutes parameter passes. It changes no game behaviour.
#define DEBUG
var/global/datum/devtools_playtest/devtools_playtest = new

/datum/devtools_playtest
	var/started
	var/profiling = FALSE

/datum/devtools_playtest/New()
	profiling = !!text2num(world.params["devtools_profile"] || "0")
	if(profiling)
		world.Profile(PROFILE_START)
	spawn(0)
		loop()

/datum/devtools_playtest/proc/elapsed()
	return (world.timeofday - started + 864000) % 864000

/datum/devtools_playtest/proc/snapshot(reason)
	fdel("devtools_playtest.json")
	var/players = 0
	for(var/client/C)
		players++
	var/list/state = list("reason" = reason, "uptime_s" = round(elapsed() / 10), "world_time_ds" = world.time,
		"cpu" = world.cpu, "players" = players, "map_cpu" = world.map_cpu)
	text2file(json_encode(state), "devtools_playtest.json")
	if(profiling)
		fdel("devtools_profile.json")
		text2file(world.Profile(PROFILE_REFRESH, null, "json"), "devtools_profile.json")

/datum/devtools_playtest/proc/loop()
	// Global datums are created before the world clock is set; start timing once it runs.
	sleep(1)
	// world.realtime is too coarse in 32-bit floats; timeofday (ds since midnight) is exact.
	started = world.timeofday
	var/minutes = text2num(world.params["devtools_minutes"] || "30")
	var/limit = minutes * 600
	while(elapsed() < limit)
		sleep(min(300, max(1, limit - elapsed())))
		if(elapsed() < limit)
			snapshot("heartbeat")
	snapshot("time limit")
	world.log << "byond-devtools: playtest time limit of [minutes] minute(s) reached; shutting down"
	shutdown()
