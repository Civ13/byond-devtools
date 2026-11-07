/turf/floor
	icon = 'icons/floor.dmi'
	icon_state = "floor"
	layer = BASE_LAYER + 0.1 // folded, printed by DreamMaker as 20.1
/turf/floor/grass
	icon_state = "grass"
	pixel_x = -4
/obj/item
	var/amount = 1
	layer = OBJ_LAYER
	dir = NORTH|EAST
	name = "\improper item"
	alpha = 255 * HALF
/obj/thing
	parent_type = /obj/item
	amount = 3
	desc = "a \"quoted\" thing"
/mob/dummy
	density = TRUE
