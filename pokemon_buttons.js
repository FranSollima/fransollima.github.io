for (var i = pokemon_evs.length - 1; i >= 0; i--) {
	var ev_pokemon = '';
	if(pokemon_evs[i].hp>0){ ev_pokemon = ev_pokemon + ' HP=' + pokemon_evs[i].hp;}
	if(pokemon_evs[i].atk>0){ ev_pokemon = ev_pokemon + ' ATK=' + pokemon_evs[i].atk;}
	if(pokemon_evs[i].def>0){ ev_pokemon = ev_pokemon + ' DEF=' + pokemon_evs[i].def;}
	if(pokemon_evs[i].spa>0){ ev_pokemon = ev_pokemon + ' SpA=' + pokemon_evs[i].spa;}
	if(pokemon_evs[i].spd>0){ ev_pokemon = ev_pokemon + ' SpD=' + pokemon_evs[i].spd;}
	if(pokemon_evs[i].spe>0){ ev_pokemon = ev_pokemon + ' SPE=' + pokemon_evs[i].spe;}
	document.write('<li class="pokemon_button" id="'+pokemon_evs[i].id+'" name="'+pokemon_evs[i].name+'" \
					hp="'+pokemon_evs[i].hp+'" atk="'+pokemon_evs[i].atk+'" def="'+pokemon_evs[i].def+'" \
					spa="'+pokemon_evs[i].spa+'" spd="'+pokemon_evs[i].spd+'" spe="'+pokemon_evs[i].spe+'" \
					onclick="add_effort_values(this.id, this.name)">#'+pokemon_evs[i].id+' - '+pokemon_evs[i].name+' -'+ev_pokemon+'</li>');
};
