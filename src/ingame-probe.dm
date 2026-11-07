// byond-devtools in-game render probe. Appended to a temporary copy of a game's .dme.
// It waits until the round is playing and lighting has settled, then writes the final
// appearance of every atom in one region (icons, states, overlays, underlays, colour
// matrices, planes, plane masters, lighting) to devtools_ingame.json and shuts down.
// It drives nothing else: game code runs unchanged. A game profile (ingame-profiles/*.dm)
// supplies ready(), settled(), set_time_of_day(), see_invisible(), time_of_day(),
// plane_masters() and profile_name().
var/global/datum/devtools_ingame_probe/devtools_ingame_probe = new

/datum/devtools_ingame_probe
	var/list/apps = list()       // appearance ref -> index
	var/list/app_rows = list()
	var/list/icons = list()      // icon key -> index
	var/list/icon_rows = list()
	var/list/notes = list()
	var/started

/datum/devtools_ingame_probe/New()
	started = world.timeofday
	spawn(10)
		drive()

/datum/devtools_ingame_probe/proc/phase(name)
	fdel("devtools_phase.txt")
	text2file("[name] [round((world.timeofday - started) / 10)]s", "devtools_phase.txt")

/datum/devtools_ingame_probe/proc/param(name, default)
	var/v = world.params[name]
	return isnull(v) ? default : v

/datum/devtools_ingame_probe/proc/drive()
	var/failure
	try
		phase("startup")
		var/deadline = world.time + text2num(param("ready_deadline_ds", "36000"))
		while(!ready())
			if(world.time > deadline)
				throw EXCEPTION("game never became ready")
			sleep(10)
		phase("ready")
		var/tod = param("time_of_day", null)
		if(tod)
			set_time_of_day(tod)
		// Let queued icon updates and lighting settle: several quiet seconds in a row.
		var/settle = text2num(param("settle_ds", "50"))
		var/quiet = 0
		while(quiet < settle)
			sleep(5)
			quiet = settled() ? quiet + 5 : 0
			if(world.time > deadline)
				throw EXCEPTION("lighting never settled")
		phase("dump")
		dump()
	catch(var/exception/e)
		failure = "[e] ([e.file]:[e.line])"
	if(failure)
		text2file(json_encode(list("failure" = failure)), "devtools_ingame.json")
	phase("done")
	shutdown()

/datum/devtools_ingame_probe/proc/icon_index(icon)
	if(!icon)
		return null
	var/key = isfile(icon) && length("[icon]") ? "file:[icon]" : "ref:\ref[icon]"
	if(icons[key])
		return icons[key]
	var/n = icon_rows.len + 1
	var/out = "devtools_icons/[n].dmi"
	var/ok = fcopy(fcopy_rsc(icon), out)
	icon_rows += list(list("source" = isfile(icon) ? "[icon]" : null, "file" = ok ? out : null))
	icons[key] = n
	return n

/datum/devtools_ingame_probe/proc/value(v)
	if(islist(v))
		var/list/L = v
		return L.Copy()
	if(isnull(v) || isnum(v) || istext(v))
		return v
	return "[v]"

// Index of one appearance (an atom's, or an overlay/underlay entry), recorded once.
/datum/devtools_ingame_probe/proc/app_index(source, ref_key)
	if(apps[ref_key])
		return apps[ref_key]
	var/mutable_appearance/M = new(source)
	var/n = app_rows.len + 1
	apps[ref_key] = n
	app_rows += list(null)
	var/list/row = list(
		"icon" = icon_index(M.icon), "icon_state" = "[M.icon_state]", "dir" = M.dir,
		"layer" = M.layer, "plane" = M.plane, "pixel_x" = M.pixel_x, "pixel_y" = M.pixel_y,
		"pixel_w" = M.pixel_w, "pixel_z" = M.pixel_z, "color" = value(M.color), "alpha" = M.alpha,
		"blend_mode" = M.blend_mode, "appearance_flags" = M.appearance_flags, "invisibility" = M.invisibility,
		"filters" = length(M.filters), "maptext" = length(M.maptext) ? 1 : 0)
	var/matrix/T = M.transform
	if(T && (T.a != 1 || T.b != 0 || T.c != 0 || T.d != 0 || T.e != 1 || T.f != 0))
		row["transform"] = list(T.a, T.b, T.c, T.d, T.e, T.f)
	var/list/over = list()
	for(var/o in M.overlays)
		over += app_index(o, ref(o))
	var/list/under = list()
	for(var/u in M.underlays)
		under += app_index(u, ref(u))
	row["overlays"] = over
	row["underlays"] = under
	app_rows[n] = row
	return n

/datum/devtools_ingame_probe/proc/dump()
	var/x1 = text2num(param("x1", "1")), y1 = text2num(param("y1", "1")), x2 = text2num(param("x2", "16")), y2 = text2num(param("y2", "16")), z = text2num(param("z", "1"))
	x2 = min(x2, world.maxx)
	y2 = min(y2, world.maxy)
	var/list/cells = list()
	var/vis = 0
	for(var/y in y1 to y2)
		for(var/x in x1 to x2)
			var/turf/T = locate(x, y, z)
			if(!T)
				continue
			var/list/movables = list()
			for(var/atom/movable/A in T)
				if(A.loc != T)
					continue
				movables += list(list(app_index(A, ref(A.appearance)), A.step_x, A.step_y, "[A.type]"))
				if(length(A.vis_contents))
					vis++
			if(length(T.vis_contents))
				vis++
			cells += list(list(x, y, app_index(T.loc, ref(T.loc.appearance)), app_index(T, ref(T.appearance)), movables, "[T.type]"))
	// Plane masters exactly as a player's HUD makes them (no client: no per-client filters).
	var/list/masters = list()
	plane_masters(masters)
	text2file(json_encode(list(
		"byond" = "[world.byond_version].[world.byond_build]", "icon_size" = world.icon_size, "map_format" = world.map_format,
		"maxx" = world.maxx, "maxy" = world.maxy, "maxz" = world.maxz, "region" = list(x1, y1, x2, y2, z),
		"see_invisible" = see_invisible(), "time_of_day" = time_of_day(), "profile" = profile_name(), "world_time" = world.time,
		"vis_contents" = vis, "plane_masters" = masters, "appearances" = app_rows, "icons" = icon_rows, "cells" = cells)), "devtools_ingame.json")
