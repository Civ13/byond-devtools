// Playtest fixture: a world with one deliberate runtime error, raised three times.
/obj/thing
	var/value = 1

/obj/thing/proc/boom()
	var/obj/thing/missing = null
	return missing.value

/proc/try_boom(obj/thing/t)
	t.boom()

/world/New()
	..()
	world.log << "fixture booted"
	spawn(5)
		var/obj/thing/t = new
		for(var/i in 1 to 3)
			try_boom(t)
