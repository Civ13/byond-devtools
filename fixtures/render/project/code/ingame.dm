// Runtime changes the static preview cannot see.
/turf/floor/New()
	..()
	if(x == 2 && y == 2)
		icon_state = "grass" // icon update at init
/obj/box/New()
	..()
	overlays += image('icons/mob.dmi', "man") // runtime overlay, inherits dir and colour
/obj/tinted/New()
	..()
	color = list(0,0,1, 0,1,0, 1,0,0) // runtime colour matrix: swap red and blue
/obj/box/turned/New()
	..()
	transform = turn(matrix(), 90)
/obj/lamp
	icon = 'icons/objs.dmi'
	icon_state = "half"
	plane = 10
	color = "#ffffff"
/obj/screen_master
	plane = 10
	blend_mode = BLEND_MULTIPLY
	appearance_flags = PLANE_MASTER
	// Lighting-style master: half "daylight" everywhere, alpha forced opaque.
	color = list(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,0, 0.5,0.5,0.5,1)
/datum/devtools_ingame_probe/proc/project_plane_masters(list/out)
	var/obj/screen_master/M = new
	out += list(list("type" = "[M.type]", "appearance" = app_index(M, ref(M.appearance))))
