// Default in-game render profile: a plain BYOND world with no round or lighting system.
/datum/devtools_ingame_probe/proc/profile_name()
	return "default"
/datum/devtools_ingame_probe/proc/ready()
	return TRUE
/datum/devtools_ingame_probe/proc/settled()
	return TRUE
/datum/devtools_ingame_probe/proc/set_time_of_day(tod)
	notes += "time_of_day ignored: no day/night system"
/datum/devtools_ingame_probe/proc/see_invisible()
	return 0
/datum/devtools_ingame_probe/proc/time_of_day()
	return null
// A project may define /datum/devtools_ingame_probe/proc/project_plane_masters(list/out).
/datum/devtools_ingame_probe/proc/plane_masters(list/out)
	if(hascall(src, "project_plane_masters"))
		call(src, "project_plane_masters")(out)
